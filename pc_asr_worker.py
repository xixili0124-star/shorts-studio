"""한국어 자동 자막 한 작업을 처리하는 오프라인 표준입출력 워커."""

import argparse
from dataclasses import dataclass
import hashlib
import importlib.metadata
import json
import logging
import math
import os
from pathlib import Path
import struct
import sys
from collections.abc import Mapping


MODEL_ID = 'dropbox-dash/faster-whisper-large-v3-turbo'
MODEL_NAME = 'large-v3-turbo'
MODEL_REV = '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf'
PACKAGE_VERSION = '1.2.1'
CT2_VERSION = '4.8.1'
MODEL_FILES = {
    'model.bin': (1617884929, 'e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da'),
    'config.json': (2263, 'b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e'),
    'preprocessor_config.json': (340, '7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711'),
    'tokenizer.json': (2710337, '297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd'),
    'vocabulary.json': (1068114, 'c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1'),
    'README.md': (1445, 'b3068692728faed23580cce5cd569fc47ff76c690c032b2641ffd5554ea64d8f'),
}
MODEL_MARKER = 'studio-model-ready.json'
SAMPLE_RATE = 16000
MAX_AUDIO_SECONDS = 180
MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * MAX_AUDIO_SECONDS
MAX_WAV_BYTES = MAX_AUDIO_BYTES + 65536
MAX_SEGMENTS = 2000
MAX_WORDS = 12000
MAX_TEXT_CHARS = 60000
VAD_PARAMETERS = {'threshold': 0.5, 'min_speech_duration_ms': 0,
                  'min_silence_duration_ms': 2000, 'speech_pad_ms': 400}
_DLL_HANDLES = []


class AsrError(ValueError):
    """미디어·인식 문장·내부 경로를 포함하지 않는 공개 오류."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class PcmAudio:
    pcm: bytes
    frames: int
    sample_rate: int = SAMPLE_RATE

    @property
    def duration(self):
        return self.frames / self.sample_rate


def decode_pcm_wav(data):
    """압축 코덱이나 파일 경로를 받지 않고 길이가 제한된 PCM WAV만 확인한다."""
    bad = AsrError('INVALID_AUDIO', '16kHz 모노 PCM16 WAV 오디오가 필요합니다.')
    if not isinstance(data, bytes) or len(data) < 44:
        raise bad
    if len(data) > MAX_WAV_BYTES:
        raise AsrError('AUDIO_TOO_LONG', '자동 자막 오디오는 한 번에 180초까지 처리할 수 있습니다.')
    if data[:4] != b'RIFF' or data[8:12] != b'WAVE':
        raise bad
    if struct.unpack_from('<I', data, 4)[0] != len(data) - 8:
        raise bad
    offset, pcm, fmt = 12, None, None
    while offset < len(data):
        if len(data) - offset < 8:
            raise bad
        name = data[offset:offset + 4]
        size = struct.unpack_from('<I', data, offset + 4)[0]
        start = offset + 8
        end = start + size
        if end > len(data) or end + (size & 1) > len(data):
            raise bad
        if name == b'fmt ':
            if fmt is not None or size not in (16, 18):
                raise bad
            fmt = struct.unpack_from('<HHIIHH', data, start)
            if fmt != (1, 1, SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16):
                raise bad
            if size == 18 and data[start + 16:end] != b'\x00\x00':
                raise bad
        elif name == b'data':
            if pcm is not None or fmt is None or not size or size % 2:
                raise bad
            if size > MAX_AUDIO_BYTES:
                raise AsrError('AUDIO_TOO_LONG', '자동 자막 오디오는 한 번에 180초까지 처리할 수 있습니다.')
            pcm = data[start:end]
        offset = end + (size & 1)
    if pcm is None or fmt is None:
        raise bad
    return PcmAudio(pcm=pcm, frames=len(pcm) // 2)


def read_pcm_wav(stream):
    return decode_pcm_wav(stream.read(MAX_WAV_BYTES + 1))


def offline_environment(base=None):
    """설치 후 추론에서는 모델 다운로드와 사용 통계를 모두 비활성화한다."""
    env = dict(os.environ if base is None else base)
    env.update({'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
                'HF_DATASETS_OFFLINE': '1', 'HF_HUB_DISABLE_TELEMETRY': '1',
                'HF_HUB_DISABLE_IMPLICIT_TOKEN': '1', 'DO_NOT_TRACK': '1',
                'TOKENIZERS_PARALLELISM': 'false', 'PYTHONNOUSERSITE': '1'})
    return env


def configure_offline():
    """Python 소켓 접근도 차단한다. 운영체제 방화벽을 대신하는 기능은 아니다."""
    os.environ.update(offline_environment())
    logging.disable(logging.CRITICAL)

    def deny_network(event, args):
        # gethostname·소켓 객체 생성은 Windows 패키지 초기화에도 쓰이는 로컬 연산이다.
        # 실제 연결·주소 조회·송신은 계속 차단하고 라이브러리가 처리할 수 있는 OSError를 쓴다.
        if event in ('socket.connect', 'socket.bind', 'socket.getaddrinfo',
                     'socket.gethostbyname', 'socket.gethostbyaddr', 'socket.sendto', 'socket.sendmsg'):
            raise OSError('Network access is disabled during PC transcription.')

    sys.addaudithook(deny_network)


def cuda_dll_directories(prefix=None):
    """현재 전용 가상환경 안에 설치된 NVIDIA DLL 디렉터리만 허용한다."""
    if os.name != 'nt':
        return []
    site = (Path(prefix or sys.prefix) / 'Lib' / 'site-packages').resolve()
    found = []
    for package, filename in (('cublas', 'cublas64_12.dll'), ('cuda_runtime', 'cudart64_12.dll')):
        directory = next((site / 'nvidia' / package / leaf for leaf in ('bin', 'lib')
                          if (site / 'nvidia' / package / leaf / filename).is_file()), None)
        if directory is None or not directory.resolve().is_relative_to(site):
            raise AsrError('RUNTIME_NOT_READY', '자동 자막 전용 CUDA 런타임을 다시 설치해 주세요.')
        if package == 'cublas' and not (directory / 'cublasLt64_12.dll').is_file():
            raise AsrError('RUNTIME_NOT_READY', '자동 자막 전용 CUDA 런타임을 다시 설치해 주세요.')
        found.append(directory.resolve())
    return found


def add_cuda_dll_directories():
    directories = cuda_dll_directories()
    for directory in directories:
        _DLL_HANDLES.append(os.add_dll_directory(str(directory)))
    if directories:
        os.environ['PATH'] = os.pathsep.join(map(str, directories)) + os.pathsep + os.environ.get('PATH', '')
    return directories


def validate_model_directory(model, revision=MODEL_REV):
    """설치 마커와 고정 크기를 확인하고 작은 설정 파일은 매번 해시로 검증한다."""
    bad = AsrError('MODEL_NOT_READY', '자동 자막 모델 설치 또는 파일 검증이 필요합니다.')
    path = Path(model)
    if revision != MODEL_REV or not path.is_absolute() or not path.is_dir():
        raise bad
    path = path.resolve()
    try:
        marker_path = path / MODEL_MARKER
        if marker_path.is_symlink() or marker_path.stat().st_size > 8192:
            raise bad
        marker = json.loads(marker_path.read_text(encoding='utf-8'))
        if (not isinstance(marker, dict) or marker.get('provider') != 'faster-whisper'
                or marker.get('modelName') != MODEL_NAME or marker.get('modelRevision') != revision):
            raise bad
        files = marker.get('files')
        if not isinstance(files, dict):
            raise bad
        for name, (size, digest) in MODEL_FILES.items():
            item = path / name
            if (item.is_symlink() or item.resolve().parent != path or not item.is_file()
                    or item.stat().st_size != size or files.get(name) != {'size': size, 'sha256': digest}):
                raise bad
            # 1.62GB 가중치의 전체 해시는 설치 때 검사하고, 작업마다 다시 읽지 않는다.
            if name != 'model.bin' and hashlib.sha256(item.read_bytes()).hexdigest() != digest:
                raise bad
    except (OSError, ValueError, TypeError):
        raise bad from None
    return path


def _value(item, name, default=None):
    return item.get(name, default) if isinstance(item, Mapping) else getattr(item, name, default)


def _number(value):
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _timing(start, end, duration):
    start, end = _number(start), _number(end)
    if start is None or end is None or start < 0 or end <= start or start >= duration:
        return None
    # 모델의 20ms 타임스탬프 양자화 때문에 파일 끝을 조금 넘는 경우만 경계에 맞춘다.
    if end > duration + 0.021:
        return None
    return start, min(end, duration)


def _clean_text(value):
    if not isinstance(value, str) or len(value) > MAX_TEXT_CHARS or '\x00' in value:
        raise AsrError('INVALID_RESULT', '자동 자막 결과 형식을 확인하지 못했습니다.')
    return value.strip()


def normalize_transcript(segments, duration, device, compute_type, revision=MODEL_REV):
    """단어 정렬이 없으면 실제 구간 시간을 남기고 단어 시간을 만들어내지 않는다."""
    duration = _number(duration)
    if duration is None or not 0 < duration <= MAX_AUDIO_SECONDS:
        raise AsrError('INVALID_AUDIO', '자동 자막 오디오의 길이를 확인하지 못했습니다.')
    result_segments, words = [], []
    previous_start = 0.0
    characters = 0
    word_characters = 0
    for index, segment in enumerate(segments):
        if index >= MAX_SEGMENTS:
            raise AsrError('INVALID_RESULT', '자동 자막 결과가 허용 범위를 넘었습니다.')
        text = _clean_text(_value(segment, 'text', ''))
        if not text:
            continue
        timing = _timing(_value(segment, 'start'), _value(segment, 'end'), duration)
        if timing is None or timing[0] < previous_start:
            raise AsrError('INVALID_RESULT', '자동 자막 결과의 시간을 확인하지 못했습니다.')
        start, end = timing
        previous_start = start
        characters += len(text)
        if characters > MAX_TEXT_CHARS:
            raise AsrError('INVALID_RESULT', '자동 자막 결과가 허용 범위를 넘었습니다.')
        aligned, valid_words, previous_word = [], True, start
        raw_words = _value(segment, 'words') or []
        for word_index, word in enumerate(raw_words):
            if word_index + len(words) >= MAX_WORDS:
                raise AsrError('INVALID_RESULT', '자동 자막 결과가 허용 범위를 넘었습니다.')
            word_text = _clean_text(_value(word, 'word', ''))
            word_characters += len(word_text)
            if word_characters > MAX_TEXT_CHARS:
                raise AsrError('INVALID_RESULT', 'Subtitle word limit exceeded.')
            if not word_text:
                continue
            word_timing = _timing(_value(word, 'start'), _value(word, 'end'), duration)
            probability = _number(_value(word, 'probability'))
            if (word_timing is None or word_timing[0] < previous_word
                    or word_timing[0] < start or word_timing[1] > end
                    or probability is None or not 0 <= probability <= 1):
                valid_words = False
                break
            previous_word = word_timing[0]
            aligned.append({'word': word_text, 'start': word_timing[0],
                            'end': word_timing[1], 'probability': probability})
        matches = ''.join(''.join(word['word'].split()) for word in aligned) == ''.join(text.split())
        if not valid_words or not aligned or not matches:
            aligned = []
        words.extend(aligned)
        result_segments.append({'text': text, 'start': start, 'end': end,
                                'words': aligned, 'timing': 'word' if aligned else 'segment'})
    fallback = any(segment['timing'] == 'segment' for segment in result_segments)
    mode = 'mixed' if fallback and words else ('segment' if fallback else 'word')
    return {'text': ' '.join(segment['text'] for segment in result_segments), 'words': words,
            'segments': result_segments, 'model': MODEL_NAME, 'modelRevision': revision,
            'device': device, 'computeType': compute_type, 'language': 'ko',
            'timingMode': mode, 'segmentFallback': fallback}


def transcribe_audio(audio, model, device, compute_type, revision=MODEL_REV):
    if (device, compute_type) not in (('cuda', 'int8_float16'), ('cpu', 'int8')):
        raise AsrError('INVALID_REQUEST', '자동 자막 실행 장치와 정밀도 설정을 확인해 주세요.')
    path = validate_model_directory(model, revision)
    if device == 'cuda':
        add_cuda_dll_directories()
    import numpy as np
    import ctranslate2
    import onnxruntime
    from faster_whisper import WhisperModel
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    if (importlib.metadata.version('faster-whisper') != PACKAGE_VERSION
            or ctranslate2.__version__ != CT2_VERSION):
        raise AsrError('RUNTIME_NOT_READY', 'Pinned ASR runtime versions are required.')
    onnxruntime.disable_telemetry_events()

    if device == 'cuda' and ctranslate2.get_cuda_device_count() < 1:
        raise AsrError('GPU_UNAVAILABLE', 'NVIDIA GPU를 사용할 수 없습니다. CPU 전환은 설치 설정에서 선택해 주세요.')
    if compute_type not in ctranslate2.get_supported_compute_types(device):
        raise AsrError('GPU_UNAVAILABLE', '선택한 자동 자막 실행 장치가 이 정밀도를 지원하지 않습니다.')
    samples = np.frombuffer(audio.pcm, dtype='<i2').astype(np.float32) / np.float32(32768.0)
    if not np.all(np.isfinite(samples)):
        raise AsrError('INVALID_AUDIO', '오디오에 올바르지 않은 값이 있습니다.')
    # 피크 비율로 약한 목소리를 버리지 않는다. 완전한 디지털 무음만 먼저 처리한다.
    if not np.any(samples):
        return normalize_transcript([], audio.duration, device, compute_type, revision)
    # 번들 VAD를 먼저 확인하면 말소리가 없는 파일에 큰 모델을 올리지 않아도 된다.
    speech = get_speech_timestamps(samples, VadOptions(**VAD_PARAMETERS), SAMPLE_RATE)
    if not speech:
        return normalize_transcript([], audio.duration, device, compute_type, revision)
    recognizer = WhisperModel(str(path), device=device, compute_type=compute_type,
                              cpu_threads=min(4, os.cpu_count() or 1), num_workers=1,
                              local_files_only=True, revision=revision)
    segments, info = recognizer.transcribe(
        samples, language='ko', task='transcribe', beam_size=5,
        word_timestamps=True, condition_on_previous_text=False,
        vad_filter=True, vad_parameters=dict(VAD_PARAMETERS),
        no_speech_threshold=0.6, log_prob_threshold=-1.0, compression_ratio_threshold=2.4,
        hallucination_silence_threshold=2.0, log_progress=False,
    )
    if info.language != 'ko':
        raise AsrError('INVALID_RESULT', '한국어 자동 자막 모델을 확인하지 못했습니다.')
    return normalize_transcript(segments, audio.duration, device, compute_type, revision)


class _ArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise AsrError('INVALID_REQUEST', '자동 자막 실행 옵션을 확인해 주세요.')


def main(argv=None, stdin=None, stdout=None):
    """오류에도 stdout에는 안전한 JSON 한 개만 보낸다."""
    status = 0
    try:
        parser = _ArgumentParser(add_help=False)
        parser.add_argument('--model', required=True)
        parser.add_argument('--device', choices=('cuda', 'cpu'), required=True)
        parser.add_argument('--compute-type', choices=('int8_float16', 'int8'), required=True)
        parser.add_argument('--revision', required=True)
        parser.add_argument('--job-name')
        args = parser.parse_args(argv)
        if args.job_name is not None:
            from pc_asr_process import WindowsJob
            try:
                if not WindowsJob.join_current(args.job_name):
                    raise OSError('ASR process job registration failed.')
            except (OSError, ValueError):
                raise AsrError('WORKER_ISOLATION_FAILED', '자동 자막 작업의 안전한 종료를 보장하지 못해 실행을 멈췄습니다. 편집기 서버를 다시 실행해 주세요.') from None
        configure_offline()
        audio = read_pcm_wav(stdin or sys.stdin.buffer)
        payload = transcribe_audio(audio, args.model, args.device, args.compute_type, args.revision)
    except AsrError as error:
        status = 1
        payload = {'error': {'code': error.code, 'message': error.message}}
    except (ImportError, ModuleNotFoundError):
        status = 1
        payload = {'error': {'code': 'RUNTIME_NOT_READY', 'message': '자동 자막 전용 환경을 다시 설치해 주세요.'}}
    except Exception as error:
        status = 1
        # 원본 예외에는 경로·문장 등이 들어갈 수 있어 절대로 외부로 출력하지 않는다.
        out_of_memory = 'out of memory' in str(error).lower()
        payload = {'error': {'code': 'GPU_MEMORY' if out_of_memory else 'ASR_FAILED',
                             'message': 'GPU 메모리가 부족합니다. 다른 GPU 작업을 종료해 주세요.' if out_of_memory
                             else '자동 자막을 완료하지 못했습니다. 설치 상태와 실행 장치를 확인해 주세요.'}}
    output = stdout if stdout is not None else sys.stdout.buffer
    output.write((json.dumps(payload, ensure_ascii=False, allow_nan=False) + '\n').encode('utf-8'))
    output.flush()
    return status


if __name__ == '__main__':
    # 네이티브 라이브러리의 출력도 막고 최종 JSON용 파이프만 별도로 보관한다.
    with os.fdopen(os.dup(sys.stdout.fileno()), 'wb') as json_output, open(os.devnull, 'w') as sink:
        sys.stdout.flush()
        sys.stderr.flush()
        os.dup2(sink.fileno(), sys.stdout.fileno())
        os.dup2(sink.fileno(), sys.stderr.fileno())
        sys.stdout = sink
        sys.stderr = sink
        sys.exit(main(stdout=json_output))
