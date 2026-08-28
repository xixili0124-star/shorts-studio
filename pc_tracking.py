"""동일 PC의 SAM 추적 작업을 직렬화하고 진행률·취소·프로세스 정리를 관리한다."""

from contextlib import nullcontext
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading
import time
import uuid

from pc_asr_process import WindowsJob
from pc_asr import stop_process
from pc_tracking_worker import (TrackingError, MODEL_NAME, MODEL_REV, SOURCE_REV,
    MODEL_FILES, MODEL_MARKER, MAX_VIDEO_BYTES, MAX_DURATION, MAX_FRAMES,
    finite_number, validate_options, validate_video, offline_environment)


ROOT = Path(__file__).resolve().parent
JOB_ID = re.compile(r'[a-f0-9]{32}')
MAX_MESSAGE_BYTES = 2 * 1024 * 1024
MAX_OUTPUT_BYTES = 4 * 1024 * 1024
GPU_BUDGET_MIB = 6144
PHASE_MESSAGES = {'decoding': '분석할 영상 프레임을 준비하는 중…',
                  'loading': 'SAM 2.1 Small 모델을 불러오는 중…',
                  'tracking': '선택한 대상을 앞뒤 구간에서 추적하는 중…'}
WORKER_ERRORS = {
    'TRACKING_GPU_MEMORY': 'GPU 메모리가 부족합니다. 다른 GPU 작업을 끝내 주세요.',
    'TRACKING_GPU_UNAVAILABLE': 'BF16을 지원하는 NVIDIA GPU와 드라이버를 확인해 주세요.',
    'TRACKING_MODEL_NOT_READY': 'PC 추적 모델을 다시 설치해 주세요.',
    'TRACKING_RUNTIME_NOT_READY': 'PC 추적 실행 환경을 다시 설치해 주세요.',
    'TRACKING_ISOLATION_FAILED': '추적 종료 환경을 확인하지 못했습니다. 실행기를 다시 시작해 주세요.',
    'TRACKING_TARGET_NOT_FOUND': '대상을 찾지 못했습니다. 선명한 프레임에서 다시 지정해 주세요.',
    'TRACKING_INVALID_VIDEO': '선택 구간을 읽지 못했습니다. MP4/WebM 형식과 영상 길이를 확인해 주세요.',
    'TRACKING_VIDEO_LIMIT': '분석할 영상이 너무 큽니다. 구간을 나눠 주세요.',
}


def read_settings(local):
    """설치기가 기록한 별도 환경과 고정 모델만 실행한다."""
    try:
        path = Path(local) / 'pc-tracking.json'
        if path.is_symlink() or path.stat().st_size > 16384:
            raise ValueError()
        settings = json.loads(path.read_text(encoding='utf-8'))
        if (not isinstance(settings, dict) or settings.get('version') != 1
                or settings.get('provider') != 'sam2' or settings.get('modelName') != MODEL_NAME
                or settings.get('modelRevision') != MODEL_REV or settings.get('sourceRevision') != SOURCE_REV
                or (settings.get('device'), settings.get('computeType')) != ('cuda', 'bfloat16')):
            raise ValueError()
        for key in ('engine', 'python', 'source', 'model'):
            value = settings.get(key)
            if not isinstance(value, str) or not Path(value).is_absolute() or Path(value).is_symlink():
                raise ValueError()
        engine, python, source, model = (Path(settings[key]).resolve()
                                         for key in ('engine', 'python', 'source', 'model'))
        if not engine.is_dir() or not python.is_file() or not source.is_dir() or not model.is_dir():
            raise ValueError()
        if any(not path.is_relative_to(engine) or path == engine for path in (python, source, model)):
            raise ValueError()
        source_marker = source / '.studio-source-revision'
        if (source_marker.is_symlink() or source_marker.stat().st_size > 100
                or source_marker.read_text(encoding='ascii').strip() != SOURCE_REV):
            raise ValueError()
        marker_path = model / MODEL_MARKER
        if marker_path.is_symlink() or marker_path.stat().st_size > 16384:
            raise ValueError()
        marker = json.loads(marker_path.read_text(encoding='utf-8'))
        if (marker.get('modelRevision') != MODEL_REV or marker.get('sourceRevision') != SOURCE_REV
                or marker.get('provider') != 'sam2' or marker.get('modelName') != MODEL_NAME):
            raise ValueError()
        for name, (size, digest) in MODEL_FILES.items():
            item = model / name
            if (item.is_symlink() or item.resolve().parent != model or item.stat().st_size != size
                    or marker.get('files', {}).get(name) != {'size': size, 'sha256': digest}):
                raise ValueError()
        return settings
    except (OSError, ValueError, TypeError, KeyError, AttributeError, UnicodeError):
        raise TrackingError('TRACKING_NOT_INSTALLED', 'PC 추적 준비가 필요합니다. setup-pc-tracking.cmd를 실행해 주세요.', 503) from None


def public_result(data, options):
    """임의 필드를 버리고 실제 구간의 정규화된 추적 좌표만 전달한다."""
    try:
        options = validate_options(options)
        if (not isinstance(data, dict) or data.get('model') != MODEL_NAME
                or data.get('modelRevision') != MODEL_REV or data.get('sourceRevision') != SOURCE_REV
                or (data.get('device'), data.get('computeType')) != ('cuda', 'bfloat16')
                or data.get('confidenceKind') != 'sam-object-presence'
                or finite_number(data.get('duration')) != options['duration']
                or finite_number(data.get('seedTime')) != options['seedTime']):
            raise ValueError()
        rows = data.get('points')
        if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_FRAMES:
            raise ValueError()
        points, previous = [], -1.0
        for row in rows:
            if not isinstance(row, dict) or type(row.get('lost')) is not bool:
                raise ValueError()
            values = {key: finite_number(row.get(key)) for key in ('t', 'x', 'y', 'w', 'h', 'confidence')}
            if (not previous < values['t'] < options['duration']
                    or values['t'] < 0 or not 0 <= values['confidence'] <= 1
                    or not 0 <= values['x'] < 1 or not 0 <= values['y'] < 1
                    or not 0 < values['w'] <= 1 or not 0 < values['h'] <= 1
                    or values['x'] + values['w'] > 1 + 1e-8
                    or values['y'] + values['h'] > 1 + 1e-8):
                raise ValueError()
            previous = values['t']
            points.append({**values, 'lost': row['lost']})
        seed = finite_number(data.get('sampledSeedTime'))
        if seed not in [row['t'] for row in points] or all(row['lost'] for row in points):
            raise ValueError()
        warnings = ['추적 결과는 직접 확인해 주세요. 존재 점수는 동일 인물임을 보장하지 않습니다.']
        if any(row['lost'] for row in points):
            warnings.append('대상을 놓친 구간이 있습니다. 해당 구간을 재지정하거나 수동 보정해 주세요.')
        return {'model': MODEL_NAME, 'modelRevision': MODEL_REV, 'sourceRevision': SOURCE_REV,
                'device': 'cuda', 'computeType': 'bfloat16', 'duration': options['duration'],
                'seedTime': options['seedTime'], 'sampledSeedTime': seed,
                'sampleFps': 15, 'confidenceKind': 'sam-object-presence',
                'points': points, 'warnings': warnings}
    except (ValueError, TypeError, KeyError):
        raise TrackingError('TRACKING_INVALID_RESULT', '올바른 추적 위치·시각을 받지 못했습니다. 기존 편집은 유지됩니다.', 502) from None


def read_messages(stream, messages):
    """작업 출력은 길이와 총량을 제한한 NDJSON으로만 받는다."""
    total, count = 0, 0
    try:
        while True:
            line = stream.readline(MAX_MESSAGE_BYTES + 1)
            if not line:
                break
            total += len(line)
            count += 1
            if (len(line) > MAX_MESSAGE_BYTES or total > MAX_OUTPUT_BYTES
                    or count > MAX_FRAMES * 3 + 64 or not line.endswith(b'\n')):
                raise ValueError()
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError()
            messages.put(('message', value))
    except (OSError, ValueError, UnicodeError):
        messages.put(('invalid', None))
    finally:
        messages.put(('eof', None))


class PcTrackingService:
    def __init__(self, local, voice=None, timeout=900):
        self.local, self.voice, self.timeout = Path(local), voice, timeout
        self.lock = threading.Lock()
        self.jobs = {}
        self.active = None
        self.uncertain = False
        self.closed = False

    def status(self):
        base = {'localServer': True, 'provider': 'sam2', 'model': MODEL_NAME,
                'modelName': 'SAM 2.1 Small', 'configured': False, 'available': False,
                'setupUrl': '/pc-tracking-setup.html', 'device': None, 'computeType': None,
                'maxDuration': MAX_DURATION, 'maxVideoBytes': MAX_VIDEO_BYTES,
                'busy': self.active is not None or bool(self.voice and self.voice.lock.locked())}
        try:
            read_settings(self.local)
            available = not self.closed and not self.uncertain and not (self.voice and self.voice.uncertain)
            return {**base, 'configured': True, 'available': available,
                    'device': 'cuda', 'computeType': 'bfloat16',
                    'reason': '이 PC에서만 추적합니다. 결과를 직접 확인해 주세요.' if available
                    else 'PC 실행기를 완전히 종료한 뒤 다시 실행해 주세요.'}
        except TrackingError as error:
            return {**base, 'reason': error.message}

    def start(self, video, options):
        validate_video(video)
        options = validate_options(options)
        settings = read_settings(self.local)
        with self.lock:
            if self.closed or self.uncertain or self.voice and self.voice.uncertain:
                raise TrackingError('TRACKING_RESTART_REQUIRED', 'PC 실행기를 다시 시작해 주세요.', 503)
            if self.active is not None or self.voice and self.voice.lock.locked():
                raise TrackingError('TRACKING_BUSY', '다른 PC AI 작업이 끝난 뒤 다시 실행해 주세요.', 409)
            now = time.monotonic()
            self.jobs = {key: job for key, job in self.jobs.items() if now - job['created'] < 600}
            while len(self.jobs) >= 8:
                del self.jobs[next(iter(self.jobs))]
            job_id = uuid.uuid4().hex
            job = {'state': 'running', 'progress': 0, 'message': 'PC 추적 작업을 준비하는 중…',
                   'created': now, 'cancel': threading.Event(), 'process': None}
            self.jobs[job_id] = job
            self.active = job_id
            thread = threading.Thread(target=self._run, args=(job_id, video, options, settings), daemon=True)
            job['thread'] = thread
            thread.start()
        return job_id

    def _job(self, job_id):
        if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id) or job_id not in self.jobs:
            raise TrackingError('TRACKING_JOB_NOT_FOUND', '추적 작업을 찾지 못했습니다. 다시 실행해 주세요.', 404)
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
                job['message'] = '추적을 중단하고 GPU·임시 파일을 정리하는 중…'
        return True

    def _collect(self, process, job, messages, options):
        deadline = time.monotonic() + self.timeout
        payload, eof = None, False
        while True:
            if job['cancel'].is_set():
                return None
            if time.monotonic() >= deadline:
                raise TrackingError('TRACKING_TIMEOUT', '추적 시간이 초과되었습니다. 구간을 나눠 주세요.', 504)
            if eof and process.poll() is not None:
                break
            try:
                kind, message = messages.get(timeout=.1)
            except queue.Empty:
                continue
            if kind == 'eof':
                eof = True
                continue
            if kind == 'invalid' or not isinstance(message, dict):
                raise TrackingError('TRACKING_INVALID_RESULT', '추적 응답 형식을 확인하지 못했습니다.', 502)
            event = message.get('type')
            if event == 'progress':
                amount, phase = finite_number(message.get('progress')), message.get('phase')
                if not 0 <= amount <= 1 or phase not in PHASE_MESSAGES:
                    raise TrackingError('TRACKING_INVALID_RESULT', '추적 진행 정보를 확인하지 못했습니다.', 502)
                job['progress'] = max(job['progress'], min(.99, amount))
                job['message'] = PHASE_MESSAGES[phase]
            elif event == 'result' and payload is None:
                payload = public_result(message.get('result'), options)
            elif event == 'error':
                error = message.get('error')
                code = error.get('code') if isinstance(error, dict) else None
                raise TrackingError(code if code in WORKER_ERRORS else 'TRACKING_ENGINE_FAILED',
                                    WORKER_ERRORS.get(code, 'PC 추적을 완료하지 못했습니다. 기존 편집은 유지됩니다.'), 502)
            else:
                raise TrackingError('TRACKING_INVALID_RESULT', '추적 응답 순서를 확인하지 못했습니다.', 502)
        if process.returncode or payload is None:
            raise TrackingError('TRACKING_ENGINE_FAILED', 'PC 추적 프로세스가 완료되지 않았습니다.', 502)
        return payload

    def _environment(self, settings):
        environment = {key: value for key, value in os.environ.items() if key.upper() in (
            'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'NUMBER_OF_PROCESSORS',
            'PROCESSOR_ARCHITECTURE', 'LOCALAPPDATA', 'USERPROFILE')}
        environment = offline_environment(environment)
        data = Path(settings['engine']) / 'data'
        if data.is_symlink() or not data.resolve().is_relative_to(Path(settings['engine']).resolve()):
            raise TrackingError('TRACKING_RUNTIME_NOT_READY', '추적 전용 작업 폴더를 확인해 주세요.', 503)
        temporary = data / 'tracking-jobs'
        if temporary.is_symlink() or not temporary.resolve().is_relative_to(data.resolve()):
            raise TrackingError('TRACKING_RUNTIME_NOT_READY', '추적 임시 폴더를 확인해 주세요.', 503)
        temporary.mkdir(parents=True, exist_ok=True)
        environment.update({'HF_HOME': str(data / 'huggingface'),
                            'TEMP': str(temporary), 'TMP': str(temporary),
                            'TORCH_HOME': str(data / 'torch')})
        return environment, temporary.resolve()

    def _dispose(self, process_job, process, reader, temporary, lease):
        failed = False
        if process_job is not None:
            try:
                process_job.close()
            except Exception:
                failed = True
        if process is not None and process.poll() is None:
            try:
                stop_process(process)
            except Exception:
                failed = True
        if reader is not None:
            reader.join(timeout=2)
            failed = failed or reader.is_alive()
        if process is not None and not failed:
            for stream in (process.stdin, process.stdout):
                if stream is not None:
                    stream.close()
        if temporary is not None and not failed:
            try:
                path = Path(temporary.name)
                if path.is_symlink() or path.resolve() != path.absolute():
                    raise OSError('Unsafe tracking temporary folder.')
                temporary.cleanup()
            except OSError:
                failed = True
        if failed:
            self.uncertain = True
            if self.voice:
                self.voice.uncertain = True
            raise TrackingError('TRACKING_STOP_FAILED', '추적 작업 정리를 확인하지 못했습니다. PC 실행기를 다시 시작해 주세요.', 503)
        if lease and self.voice:
            try:
                self.voice.release_asr(lease['token'])
            except Exception:
                self.uncertain = self.voice.uncertain = True
                raise TrackingError('TRACKING_RELEASE_FAILED', 'GPU 작업 잠금 해제를 확인하지 못했습니다. 실행기를 다시 시작해 주세요.', 503) from None

    def _run(self, job_id, video, options, settings):
        job = self.jobs[job_id]
        process = process_job = reader = temporary = lease = outcome = None
        try:
            with self.voice.exclusive() if self.voice else nullcontext():
                try:
                    if self.voice and self.voice.uncertain:
                        raise TrackingError('TRACKING_RESTART_REQUIRED', 'PC 실행기를 다시 시작해 주세요.', 503)
                    if job['cancel'].is_set():
                        return
                    if self.voice:
                        lease = self.voice.reserve_asr(required_free_mib=GPU_BUDGET_MIB, ttl=self.timeout + 60)
                    if job['cancel'].is_set():
                        return
                    environment, temp_root = self._environment(settings)
                    temporary = tempfile.TemporaryDirectory(prefix=job_id + '-', dir=temp_root)
                    directory = Path(temporary.name).resolve()
                    if directory.parent != temp_root:
                        raise TrackingError('TRACKING_RUNTIME_NOT_READY', '추적 작업 폴더가 올바르지 않습니다.', 503)
                    video_path = directory / 'input-video.bin'
                    video_path.write_bytes(video)
                    video = None
                    environment['TEMP'] = environment['TMP'] = str(directory)
                    command = [settings['python'], str(ROOT / 'pc_tracking_worker.py'),
                               '--model', settings['model'], '--revision', MODEL_REV,
                               '--video', str(video_path), '--work-dir', str(directory)]
                    process_job = WindowsJob()
                    if process_job.name is not None:
                        command.extend(['--job-name', process_job.name])
                    process = subprocess.Popen(command, cwd=ROOT, env=environment, stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                    job['process'] = process
                    messages = queue.SimpleQueue()
                    reader = threading.Thread(target=read_messages, args=(process.stdout, messages), daemon=True)
                    reader.start()
                    process.stdin.write(json.dumps(options, allow_nan=False).encode('utf-8'))
                    process.stdin.close()
                    outcome = self._collect(process, job, messages, options)
                finally:
                    try:
                        self._dispose(process_job, process, reader, temporary, lease)
                    except Exception:
                        # 종료 미확인 프로세스가 파일을 쓰는 동안 자동 삭제가 일어나지 않게 보관한다.
                        job['_temporary'] = temporary
                        raise
        except Exception as error:
            if isinstance(error, TrackingError):
                code, message = error.code, error.message
            elif getattr(error, 'code', '') == 'VOICE_BUSY':
                code, message = 'TRACKING_BUSY', '다른 PC AI 작업이 끝난 뒤 다시 실행해 주세요.'
            elif getattr(error, 'code', '') == 'ASR_GPU_MEMORY':
                code, message = 'TRACKING_GPU_MEMORY', WORKER_ERRORS['TRACKING_GPU_MEMORY']
            else:
                code, message = 'TRACKING_ENGINE_FAILED', 'PC 추적 연결 또는 실행에 실패했습니다. 준비 상태를 확인해 주세요.'
            job['error'] = {'code': code, 'message': message}
        finally:
            with self.lock:
                if job['cancel'].is_set() and not self.uncertain:
                    job.update(state='cancelled', message='추적을 취소했습니다. 기존 편집은 그대로입니다.')
                    job.pop('error', None)
                elif outcome is not None and 'error' not in job:
                    job.update(state='done', progress=1, message='SAM 추적 완료. 결과를 확인해 주세요.', result=outcome)
                else:
                    job.update(state='failed', message=job.get('error', {}).get('message', '추적을 완료하지 못했습니다.'))
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
                    self.uncertain = True
                    if self.voice:
                        self.voice.uncertain = True
                    raise TrackingError('TRACKING_SHUTDOWN_TIMEOUT', '추적 종료가 지연됩니다. PC 실행기를 완전히 종료해 주세요.', 503)
