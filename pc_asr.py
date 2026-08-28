"""같은 PC에서만 실행하는 자동자막 작업과 취소·수명 관리를 담당합니다."""
from contextlib import nullcontext
import io
import json
import math
import os
from pathlib import Path
import re
import subprocess
import threading
import time
import uuid
import wave
from pc_asr_process import WindowsJob

ROOT = Path(__file__).resolve().parent
MAX_AUDIO_BYTES = 16000 * 180 * 2 + 65536
MAX_RESULT_BYTES = 2 * 1024 * 1024
JOB_ID = re.compile(r'[a-f0-9]{32}')
MODEL_NAME = 'large-v3-turbo'


class AsrError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def validate_audio(content):
    """파일 경로나 압축 미디어 대신 길이가 제한된 PCM WAV만 받습니다."""
    if not isinstance(content, bytes) or not 44 <= len(content) <= MAX_AUDIO_BYTES:
        raise AsrError('ASR_AUDIO_LIMIT', '자동자막은 3분 이하의 음성만 처리할 수 있습니다.', 413)
    try:
        if content[:4] != b'RIFF' or content[8:12] != b'WAVE':
            raise ValueError()
        with wave.open(io.BytesIO(content), 'rb') as audio:
            frames = audio.getnframes()
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 16000, 'NONE'):
                raise ValueError()
            if not 1 <= frames <= 16000 * 180 or len(audio.readframes(frames)) != frames * 2:
                raise ValueError()
            return frames / 16000
    except (wave.Error, EOFError, ValueError, OSError):
        raise AsrError('ASR_INVALID_AUDIO', '16kHz 모노 PCM WAV 음성을 끝까지 읽지 못했습니다.') from None


def read_settings(local):
    """설치기가 고정한 로컬 실행 파일과 모델만 사용합니다."""
    try:
        config = Path(local) / 'pc-asr.json'
        if config.is_symlink() or config.stat().st_size > 16384:
            raise ValueError()
        settings = json.loads(config.read_text(encoding='utf-8'))
        from setup_pc_asr import MODEL_REV, MODEL_FILES
        if (not isinstance(settings, dict) or settings.get('version') != 1
                or settings.get('provider') != 'faster-whisper' or settings.get('modelName') != MODEL_NAME
                or settings.get('modelRevision') != MODEL_REV):
            raise ValueError()
        for key in ('engine', 'python', 'model'):
            value = settings.get(key)
            if not isinstance(value, str) or not Path(value).is_absolute() or Path(value).is_symlink():
                raise ValueError()
        engine = Path(settings['engine']).resolve()
        python = Path(settings['python']).resolve()
        model = Path(settings['model']).resolve()
        if not python.is_file() or not python.is_relative_to(engine) or not model.is_relative_to(engine):
            raise ValueError()
        if (settings.get('device'), settings.get('computeType')) not in (('cuda', 'int8_float16'), ('cpu', 'int8')):
            raise ValueError()
        marker_path = model / 'studio-model-ready.json'
        if marker_path.is_symlink() or marker_path.stat().st_size > 32768:
            raise ValueError()
        marker = json.loads(marker_path.read_text(encoding='utf-8'))
        if marker.get('modelRevision') != MODEL_REV:
            raise ValueError()
        for name, (size, _) in MODEL_FILES.items():
            path = model / name
            if path.is_symlink() or path.resolve().parent != model or path.stat().st_size != size:
                raise ValueError()
        dll_dirs = settings.get('cudaDllDirs', [])
        if not isinstance(dll_dirs, list) or len(dll_dirs) > 8:
            raise ValueError()
        for directory in dll_dirs:
            if (not isinstance(directory, str) or not Path(directory).is_absolute()
                    or not Path(directory).resolve().is_relative_to(engine) or not Path(directory).is_dir()):
                raise ValueError()
        return settings
    except (OSError, ImportError, ValueError, TypeError, KeyError, AttributeError):
        raise AsrError('ASR_NOT_INSTALLED', 'PC 자막 엔진 준비가 필요합니다. setup-pc-asr.cmd를 실행해 주세요.', 503) from None


def public_result(data, duration, expected=None):
    """내부 경로·임의 출력은 버리고 실제 음성 범위 안의 결과만 반환합니다."""
    try:
        if (not isinstance(data, dict) or data.get('model') != MODEL_NAME
                or (data.get('device'), data.get('computeType')) not in (('cuda', 'int8_float16'), ('cpu', 'int8'))
                or not isinstance(data.get('text'), str) or len(data['text']) > 64000):
            raise ValueError()
        if expected is not None and any(data.get(key) != expected.get(key) for key in ('device', 'computeType')):
            raise ValueError()
        result = {key: data[key] for key in ('text', 'model', 'device', 'computeType')}
        for key, text_key, maximum in (('words', 'word', 10000), ('segments', 'text', 3000)):
            rows = data.get(key, [])
            if not isinstance(rows, list) or len(rows) > maximum:
                raise ValueError()
            clean = []
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get(text_key), str) or len(row[text_key]) > 4000:
                    raise ValueError()
                start, end = row.get('start'), row.get('end')
                if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in (start, end)):
                    raise ValueError()
                if not 0 <= start < end <= duration + .1:
                    raise ValueError()
                if start >= duration:
                    raise ValueError()
                cleaned = {text_key: row[text_key], 'start': start, 'end': min(end, duration)}
                probability = row.get('probability')
                if isinstance(probability, (int, float)) and not isinstance(probability, bool) and math.isfinite(probability) and 0 <= probability <= 1:
                    cleaned['probability'] = probability
                if key == 'segments':
                    nested = row.get('words', [])
                    if not isinstance(nested, list) or len(nested) > 1000:
                        raise ValueError()
                    validated = public_result({'text': '', 'model': MODEL_NAME, 'device': data['device'],
                        'computeType': data['computeType'], 'words': nested, 'segments': []}, duration)
                    cleaned['words'] = validated['words']
                    cleaned['timing'] = 'word' if cleaned['words'] else 'segment'
                clean.append(cleaned)
            result[key] = clean
        skipped = data.get('skipped', 0)
        if not isinstance(skipped, int) or isinstance(skipped, bool) or not 0 <= skipped <= 10000:
            raise ValueError()
        result['skipped'] = skipped
        has_words = any(segment['words'] for segment in result['segments'])
        fallback = any(not segment['words'] for segment in result['segments'])
        result['segmentFallback'] = fallback
        result['timingMode'] = 'mixed' if has_words and fallback else 'segment' if fallback else 'word'
        return result
    except (ValueError, TypeError, KeyError):
        raise AsrError('ASR_INVALID_RESULT', '자막 엔진이 올바른 원문·시간 정보를 반환하지 못했습니다. 기존 자막은 유지됩니다.', 502) from None


def stop_process(process):
    """우리가 시작한 프로세스 트리만 중단하고 종료를 확인합니다."""
    if process is None or process.poll() is not None:
        return
    if os.name == 'nt':
        result = subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), timeout=15)
        if result.returncode and process.poll() is None:
            raise AsrError('ASR_STOP_FAILED', 'PC 자막 작업 종료를 확인하지 못했습니다. 편집기 실행기를 다시 시작해 주세요.', 503)
    else:
        process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


class PcAsrService:
    def __init__(self, local, voice=None, timeout=600):
        self.local = Path(local)
        self.voice = voice
        self.timeout = timeout
        self.lock = threading.Lock()
        self.jobs = {}
        self.active = None
        self.uncertain = False
        self.closed = False

    def status(self):
        base = {'localServer': True, 'provider': 'faster-whisper', 'model': MODEL_NAME,
            'modelName': 'Whisper large-v3-turbo', 'setupUrl': '/pc-asr-setup.html',
            'busy': self.active is not None or bool(self.voice and self.voice.lock.locked()),
            'configured': False, 'available': False, 'device': None, 'computeType': None}
        try:
            settings = read_settings(self.local)
            return {**base, 'configured': True, 'available': not self.uncertain and not self.closed,
                'device': settings['device'], 'computeType': settings['computeType'],
                'reason': 'PC 실행기를 다시 시작해 주세요.' if self.uncertain or self.closed else '이 PC에서만 처리합니다. 인식 중에는 다른 PC AI 작업을 잠시 기다려 주세요.'}
        except AsrError as error:
            return {**base, 'reason': error.message}

    def start(self, audio):
        duration = validate_audio(audio)
        settings = read_settings(self.local)
        with self.lock:
            if self.closed or self.uncertain:
                raise AsrError('ASR_RESTART_REQUIRED', 'PC 실행기를 다시 시작한 뒤 자막을 생성해 주세요.', 503)
            if self.active is not None or self.voice and self.voice.lock.locked():
                raise AsrError('ASR_BUSY', '다른 PC AI 작업이 처리 중입니다. 완료 후 다시 실행해 주세요.', 409)
            now = time.monotonic()
            self.jobs = {key: value for key, value in self.jobs.items() if now - value['created'] < 600}
            while len(self.jobs) >= 8:
                del self.jobs[next(iter(self.jobs))]
            job_id = uuid.uuid4().hex
            job = {'state': 'running', 'progress': None, 'message': 'PC 자막 모델 준비·한국어 인식 중…',
                'created': now, 'cancel': threading.Event(), 'process': None}
            self.jobs[job_id] = job
            self.active = job_id
            thread = threading.Thread(target=self._run, args=(job_id, audio, duration, settings), daemon=True)
            job['thread'] = thread
            thread.start()
        return job_id

    def _job(self, job_id):
        if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id) or job_id not in self.jobs:
            raise AsrError('ASR_JOB_NOT_FOUND', '이 자막 작업을 찾지 못했습니다. 다시 시작해 주세요.', 404)
        return self.jobs[job_id]

    def get(self, job_id):
        with self.lock:
            job = self._job(job_id)
            return {key: job[key] for key in ('state', 'progress', 'message', 'result', 'error') if key in job}

    def cancel(self, job_id):
        with self.lock:
            job = self._job(job_id)
            if job['state'] == 'running':
                job['cancel'].set()
                job['message'] = '인식을 중단하고 GPU 메모리를 정리하는 중…'
        return True

    def _run(self, job_id, audio, duration, settings):
        job = self.jobs[job_id]
        process = None
        process_job = None
        lease = None
        outcome = None
        try:
            with self.voice.exclusive() if self.voice else nullcontext():
                try:
                    if self.voice and self.voice.uncertain:
                        raise AsrError('ASR_VOICE_BUSY', '이전 TTS 작업 완료를 확인하지 못했습니다. PC 실행기를 다시 시작해 주세요.', 503)
                    if job['cancel'].is_set():
                        return
                    if self.voice and settings['device'] == 'cuda':
                        lease = self.voice.reserve_asr(required_free_mib=3584, ttl=self.timeout + 60)
                        if lease and lease.get('modelUnloaded'):
                            job['message'] = 'GPU 메모리를 확보했어요. Turbo 모델을 불러와 인식 중…'
                    if job['cancel'].is_set():
                        return
                    environment = {key: value for key, value in os.environ.items() if key.upper() in (
                        'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'NUMBER_OF_PROCESSORS',
                        'PROCESSOR_ARCHITECTURE', 'LOCALAPPDATA', 'USERPROFILE')}
                    data = Path(settings['engine']) / 'data'
                    (data / 'temp').mkdir(parents=True, exist_ok=True)
                    environment.update({'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
                        'HF_HUB_DISABLE_TELEMETRY': '1', 'DO_NOT_TRACK': '1', 'PYTHONNOUSERSITE': '1',
                        'PYTHONDONTWRITEBYTECODE': '1', 'TOKENIZERS_PARALLELISM': 'false',
                        'HF_HOME': str(data / 'huggingface'), 'TEMP': str(data / 'temp'), 'TMP': str(data / 'temp'),
                        'OMP_NUM_THREADS': '4'})
                    environment['PATH'] = os.pathsep.join([*settings.get('cudaDllDirs', []), environment.get('PATH', '')])
                    command = [settings['python'], str(ROOT / 'pc_asr_worker.py'), '--model', settings['model'],
                        '--device', settings['device'], '--compute-type', settings['computeType'],
                        '--revision', settings['modelRevision']]
                    process_job = WindowsJob()
                    if process_job.name is not None:
                        command.extend(['--job-name', process_job.name])
                    process = subprocess.Popen(command, cwd=ROOT, env=environment, stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                    job['process'] = process
                    deadline = time.monotonic() + self.timeout
                    first = True
                    while True:
                        if job['cancel'].is_set():
                            return
                        if time.monotonic() >= deadline:
                            raise AsrError('ASR_TIMEOUT', '인식 시간이 초과되었습니다. 더 짧은 구간으로 다시 시도해 주세요.', 504)
                        try:
                            output, _ = process.communicate(input=audio if first else None, timeout=.25)
                            break
                        except subprocess.TimeoutExpired:
                            first = False
                    if job['cancel'].is_set():
                        return
                    if len(output) > MAX_RESULT_BYTES:
                        raise AsrError('ASR_RESULT_LIMIT', '자막 결과가 너무 깁니다. 구간을 나눠 주세요.', 502)
                    try:
                        payload = json.loads(output)
                    except (ValueError, UnicodeError):
                        payload = {}
                    if process.returncode or not isinstance(payload, dict) or 'error' in payload:
                        code = payload.get('error', {}).get('code', '') if isinstance(payload, dict) and isinstance(payload.get('error'), dict) else ''
                        messages = {'GPU_MEMORY': 'GPU 메모리가 부족합니다. 다른 GPU 작업을 닫고 다시 시도해 주세요.',
                            'GPU_UNAVAILABLE': 'CUDA를 사용할 수 없습니다. NVIDIA 드라이버와 PC 자막 설치 상태를 확인해 주세요.',
                            'RUNTIME_NOT_READY': 'PC 자막 전용 실행 환경을 다시 설치해 주세요.',
                            'MODEL_NOT_READY': 'PC 자막 모델 파일이 불완전합니다. 설치 도구를 다시 실행해 주세요.',
                            'WORKER_ISOLATION_FAILED': 'PC 자막 작업의 안전한 종료 환경을 준비하지 못했습니다. PC 실행기를 다시 시작해 주세요.',
                            'NO_SPEECH': '인식할 말소리를 찾지 못했습니다. 기존 자막은 그대로 유지됩니다.'}
                        raise AsrError('ASR_ENGINE_FAILED', messages.get(code, 'PC 자막 엔진이 인식을 완료하지 못했습니다. 설치 상태를 확인하거나 짧은 구간으로 다시 시도해 주세요.'), 502)
                    outcome = public_result(payload, duration, settings)
                finally:
                    cleanup_failed = False
                    # venv 실행기가 먼저 끝나도 실제 추론 프로세스와 자식들의 종료를 확인한다.
                    if process_job is not None:
                        try:
                            process_job.close()
                        except Exception:
                            cleanup_failed = True
                    if process is not None and process.poll() is None:
                        try:
                            stop_process(process)
                        except Exception:
                            cleanup_failed = True
                    if cleanup_failed:
                        self.uncertain = True
                        if self.voice:
                            self.voice.uncertain = True
                        raise AsrError('ASR_STOP_FAILED', 'PC 자막 작업 종료를 확인하지 못했습니다. 편집기 실행기를 다시 시작해 주세요.', 503) from None
                    if lease and self.voice and not self.uncertain:
                        try:
                            self.voice.release_asr(lease['token'])
                        except Exception:
                            self.uncertain = self.voice.uncertain = True
                            raise AsrError('ASR_RELEASE_FAILED', '자막 인식 후 PC 음성 엔진의 작업 잠금 해제를 확인하지 못했습니다. PC 실행기를 다시 시작해 주세요.', 503) from None
        except Exception as error:
            if isinstance(error, AsrError):
                code, message = error.code, error.message
            elif getattr(error, 'code', '') in ('VOICE_BUSY', 'ENGINE_RESTART_REQUIRED'):
                code, message = 'ASR_BUSY', 'PC 음성 엔진이 작업 중이거나 재시작이 필요합니다. 완료 후 다시 시도해 주세요.'
            elif getattr(error, 'code', '') == 'ASR_GPU_MEMORY':
                code, message = 'ASR_GPU_MEMORY', '자막용 GPU 메모리가 부족합니다. 다른 GPU 작업을 끝내고 다시 시도해 주세요.'
            else:
                code, message = 'ASR_ENGINE_FAILED', 'PC 자막 연결 또는 실행에 실패했습니다. 설치·연결 상태를 확인해 주세요.'
            job['error'] = {'code': code, 'message': message}
        finally:
            with self.lock:
                if job['cancel'].is_set() and not self.uncertain:
                    job.update(state='cancelled', message='인식을 취소했습니다. 기존 자막은 그대로입니다.')
                    job.pop('error', None)
                elif outcome is not None and 'error' not in job:
                    job.update(state='done', progress=1, message='한국어 인식 완료', result=outcome)
                else:
                    job.update(state='failed', message=job.get('error', {}).get('message', 'PC 자막 작업을 완료하지 못했습니다.'))
                job['process'] = None
                self.active = None

    def close(self):
        with self.lock:
            self.closed = True
            jobs = list(self.jobs.values())
            for job in jobs:
                job['cancel'].set()
        for job in jobs:
            thread = job.get('thread')
            if thread is not None and thread.is_alive():
                thread.join(timeout=35)
                if thread.is_alive():
                    # 종료 미확인 상태에서 다른 TTS 작업이 GPU를 사용하지 않도록 한다.
                    self.uncertain = True
                    if self.voice:
                        self.voice.uncertain = True
                    raise AsrError('ASR_SHUTDOWN_TIMEOUT', 'PC 자막 작업 종료가 지연되고 있습니다. PC 실행기를 완전히 종료한 뒤 다시 실행해 주세요.', 503)
