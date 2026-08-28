"""Private, loopback-only GPT-SoVITS adapter. No cloud fallback or user-supplied paths."""
import base64
import binascii
from contextlib import contextmanager
import io
import hmac
import hashlib
import json
import math
from pathlib import Path
import re
import threading
import uuid
import wave
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


MAX_REFERENCE_BODY = 2 * 1024 * 1024
MAX_REFERENCE_BYTES = 1024 * 1024
MAX_RESULT_BYTES = 32 * 1024 * 1024
MAX_PROFILES = 12
PROFILE_ID = re.compile(r'^[a-f0-9]{32}$')


def local_engine_key(settings_path):
    """Read a private helper credential; never return it to the browser or logs."""
    try:
        path = Path(settings_path)
        if path.stat().st_size > 16384:
            return None
        key = json.loads(path.read_text(encoding='utf-8')).get('engineKey')
        return key if isinstance(key, str) and re.fullmatch(r'[A-Za-z0-9_-]{32,128}', key) else None
    except (OSError, ValueError, AttributeError):
        return None


class VoiceError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def engine_proof(key, nonce):
    return hmac.new(key.encode('ascii'), ('studio-pc-voice-v1:' + nonce).encode('ascii'), hashlib.sha256).hexdigest()


def verified_engine(opener, endpoint, key, timeout=3):
    """A raw GPT-SoVITS API ignores our key; require the private wrapper's proof."""
    if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', key):
        return False
    nonce = uuid.uuid4().hex
    request = Request(endpoint + '/studio/health', headers={'Accept': 'application/json',
        'X-Studio-Engine-Nonce': nonce})
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(4097)
        if len(raw) > 4096:
            return False
        data = json.loads(raw)
        return (data.get('service') == 'shorts-studio-pc-voice' and data.get('protocol') == 1
            and isinstance(data.get('proof'), str) and hmac.compare_digest(data['proof'], engine_proof(key, nonce)))
    except (HTTPError, URLError, TimeoutError, OSError, ValueError, AttributeError, TypeError):
        return False


def wav_info(content, reference=False):
    """Check actual PCM frames, not just a RIFF signature or supplied duration."""
    maximum = MAX_REFERENCE_BYTES if reference else MAX_RESULT_BYTES
    try:
        if not 44 <= len(content) <= maximum or content[:4] != b'RIFF' or content[8:12] != b'WAVE':
            raise ValueError()
        if int.from_bytes(content[4:8], 'little') + 8 != len(content):
            raise ValueError()
        with wave.open(io.BytesIO(content), 'rb') as audio:
            channels, width, rate, frames = audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getnframes()
            if audio.getcomptype() != 'NONE' or width != 2 or channels not in (1, 2) or not 16000 <= rate <= 96000:
                raise ValueError()
            if reference and (channels != 1 or rate > 48000):
                raise ValueError()
            duration = frames / rate
            low, high = (3, 10) if reference else (.05, 300)
            if not low <= duration <= high:
                raise ValueError()
            pcm = audio.readframes(frames)
            if len(pcm) != frames * channels * width:
                raise ValueError()
            if reference:
                # Reject silence; this is not a speech/identity detector.
                import array
                samples = array.array('h', pcm)
                import sys
                if sys.byteorder != 'little':
                    samples.byteswap()
                if max((abs(value) for value in samples), default=0) < 32:
                    raise ValueError()
        return {'duration': duration, 'sampleRate': rate, 'channels': channels}
    except (ValueError, EOFError, wave.Error, OverflowError):
        message = '참고 음성은 소리가 있는 3~10초의 모노 PCM WAV여야 합니다.' if reference else 'PC 엔진에서 정상적인 WAV를 받지 못했습니다. 원고를 줄여 다시 시도해 주세요.'
        raise VoiceError('INVALID_REFERENCE' if reference else 'INVALID_AUDIO', message, 400 if reference else 502) from None


class VoiceCloneService:
    def __init__(self, directory, port=9880, timeout=300, engine_key=None):
        if isinstance(port, bool) or not isinstance(port, int) or not 1024 <= port <= 65535:
            raise ValueError('Invalid local voice port')
        self.directory = Path(directory).resolve()
        self.endpoint = f'http://127.0.0.1:{port}'
        self.timeout = timeout
        self.engine_headers = {'X-Studio-Engine-Key': engine_key} if engine_key else {}
        # Ignore HTTP_PROXY/HTTPS_PROXY and never follow an upstream redirect.
        self.opener = build_opener(ProxyHandler({}), NoRedirect())
        self.lock = threading.Lock()
        self.uncertain = False

    @contextmanager
    def exclusive(self):
        if not self.lock.acquire(blocking=False):
            raise VoiceError('VOICE_BUSY', 'PC 엔진이 작업 중입니다. 결과 받기를 취소했어도 현재 생성이 끝날 때까지 기다려 주세요.', 409)
        try:
            yield
        finally:
            self.lock.release()

    def _path(self, profile_id, suffix):
        if not isinstance(profile_id, str) or not PROFILE_ID.fullmatch(profile_id):
            raise VoiceError('INVALID_PROFILE', '등록한 목소리를 다시 선택해 주세요.')
        path = self.directory / (profile_id + suffix)
        # A link/junction must not turn a profile into an arbitrary file read.
        if path.is_symlink() or path.resolve().parent != self.directory:
            raise VoiceError('INVALID_PROFILE', '목소리 보관 파일을 확인해 주세요.')
        return path

    def _load(self, profile_id, require_audio=True):
        try:
            path = self._path(profile_id, '.json')
            if path.stat().st_size > 8192:
                raise ValueError()
            data = json.loads(path.read_text(encoding='utf-8'))
            if data.get('id') != profile_id or data.get('language') != 'ko' or not isinstance(data.get('name'), str) or not isinstance(data.get('promptText'), str):
                raise ValueError()
            audio = self._path(profile_id, '.wav')
            if require_audio:
                audio.stat()
            data['audioAvailable'] = audio.is_file()
            return data
        except (OSError, ValueError, TypeError, AttributeError):
            raise VoiceError('PROFILE_NOT_FOUND', '등록한 목소리를 찾지 못했습니다. 다시 등록해 주세요.', 404) from None

    def profiles(self):
        profiles = []
        if self.directory.exists():
            for path in sorted(self.directory.glob('*.json'))[:MAX_PROFILES + 1]:
                try:
                    row = self._load(path.stem, require_audio=False)
                    profiles.append({key: row[key] for key in ('id', 'name', 'duration', 'promptText', 'audioAvailable')})
                except (VoiceError, KeyError):
                    continue
        return profiles

    def status(self):
        base = {'provider': 'gpt-sovits', 'localServer': True, 'inferenceVerified': False,
                'profiles': self.profiles(), 'maxProfiles': MAX_PROFILES}
        if self.uncertain:
            return {**base, 'state': 'restart-required', 'message': '이전 요청의 완료를 확인하지 못했습니다. PC 음성 엔진과 편집기 서버를 다시 실행해 주세요.'}
        if not self.lock.acquire(blocking=False):
            return {**base, 'state': 'busy', 'message': 'PC 엔진이 처리 중입니다. 잠시 뒤 연결을 다시 확인해 주세요.'}
        try:
            if not verified_engine(self.opener, self.endpoint, self.engine_headers.get('X-Studio-Engine-Key')):
                raise ValueError()
            return {**base, 'state': 'ready', 'message': 'PC 엔진 연결됨 · 등록한 목소리로 생성할 수 있어요.'}
        except (HTTPError, URLError, TimeoutError, OSError, ValueError, AttributeError):
            return {**base, 'state': 'offline', 'message': 'PC 음성 엔진이 꺼져 있거나 준비 중입니다. PC 음성 시작 후 연결을 다시 확인해 주세요.'}
        finally:
            self.lock.release()

    def register(self, data):
        if not isinstance(data, dict) or data.get('consent') is not True:
            raise VoiceError('VOICE_CONSENT_REQUIRED', '본인 또는 사용 허락을 받은 목소리인지 확인해 주세요.', 403)
        name, prompt, encoded = data.get('name'), data.get('promptText'), data.get('audio')
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60 or not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 500:
            raise VoiceError('INVALID_REFERENCE_TEXT', '목소리 이름(60자 이내)과 녹음에서 실제로 읽은 문장(500자 이내)을 입력해 주세요.')
        if not isinstance(encoded, str) or len(encoded) > MAX_REFERENCE_BYTES * 4 // 3 + 4:
            raise VoiceError('REFERENCE_LIMIT', '참고 음성 파일이 너무 큽니다.', 413)
        try:
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise VoiceError('INVALID_REFERENCE', '참고 음성을 다시 선택해 주세요.') from None
        info = wav_info(content, reference=True)
        with self.exclusive():
            self.directory.mkdir(parents=True, exist_ok=True)
            if len(list(self.directory.glob('*.json'))) >= MAX_PROFILES:
                raise VoiceError('PROFILE_LIMIT', '목소리는 12개까지 보관할 수 있습니다. 사용하지 않는 목소리를 먼저 지워 주세요.', 409)
            profile_id = uuid.uuid4().hex
            row = {'id': profile_id, 'name': name.strip(), 'promptText': prompt.strip(), 'language': 'ko', **info}
            try:
                metadata = json.dumps(row, ensure_ascii=False).encode('utf-8')
            except UnicodeError:
                raise VoiceError('INVALID_REFERENCE_TEXT', '목소리 이름과 읽은 문장의 문자를 확인해 주세요.') from None
            wav_path, json_path = self._path(profile_id, '.wav'), self._path(profile_id, '.json')
            try:
                # Publish metadata last so incomplete profiles are never listed.
                with wav_path.open('xb') as stream:
                    stream.write(content)
                with json_path.open('xb') as stream:
                    stream.write(metadata)
            except OSError:
                wav_path.unlink(missing_ok=True)
                json_path.unlink(missing_ok=True)
                raise VoiceError('REFERENCE_STORAGE', 'PC에 참고 음성을 저장하지 못했습니다. 저장 공간을 확인해 주세요.', 500) from None
        return {key: row[key] for key in ('id', 'name', 'duration', 'promptText')}

    def delete(self, profile_id):
        with self.exclusive():
            self._load(profile_id, require_audio=False)
            try:
                # Retain metadata until the recording is gone, so a Windows file
                # lock cannot hide undeleted private audio from the retry UI.
                self._path(profile_id, '.wav').unlink(missing_ok=True)
                self._path(profile_id, '.json').unlink()
            except OSError:
                raise VoiceError('REFERENCE_STORAGE', '참고 음성 파일을 삭제하지 못했습니다. PC 저장 폴더의 권한을 확인해 주세요.', 500) from None

    def synthesize(self, data):
        if not isinstance(data, dict) or data.get('consent') is not True:
            raise VoiceError('VOICE_CONSENT_REQUIRED', '목소리 사용과 PC 처리 안내를 확인해 주세요.', 403)
        text, speed = data.get('text'), data.get('speed', 1)
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= 2000 or isinstance(speed, bool) or not isinstance(speed, (int, float)) or not math.isfinite(speed) or not .75 <= speed <= 1.5:
            raise VoiceError('INVALID_SYNTHESIS', '원고는 1~2,000자, 속도는 0.75~1.5배로 입력해 주세요.')
        with self.exclusive():
            if self.uncertain:
                raise VoiceError('ENGINE_RESTART_REQUIRED', '이전 요청의 완료가 불확실합니다. PC 음성 엔진과 편집기 서버를 다시 실행해 주세요.', 503)
            profile = self._load(data.get('profileId'))
            reference = self._path(profile['id'], '.wav')
            try:
                with reference.open('rb') as stream:
                    wav_info(stream.read(MAX_REFERENCE_BYTES + 1), reference=True)
            except OSError:
                raise VoiceError('PROFILE_NOT_FOUND', '참고 음성을 읽지 못했습니다. 다시 등록해 주세요.', 404) from None
            # Recheck identity without sending our key or any voice data first.
            self.require_engine()
            payload = {'text': text.strip(), 'text_lang': 'ko', 'ref_audio_path': str(reference),
                       'prompt_text': profile['promptText'], 'prompt_lang': 'ko', 'speed_factor': speed,
                       'media_type': 'wav', 'streaming_mode': False, 'text_split_method': 'cut5',
                       'batch_size': 1, 'parallel_infer': True, 'seed': 42}
            request = Request(self.endpoint + '/tts', data=json.dumps(payload).encode('utf-8'),
                              headers={'Content-Type': 'application/json', 'Accept': 'audio/wav', **self.engine_headers}, method='POST')
            try:
                with self.opener.open(request, timeout=self.timeout) as response:
                    result = response.read(MAX_RESULT_BYTES + 1)
                info = wav_info(result)
                return result, info
            except HTTPError:
                # Never forward model paths, prompt text, tracebacks, or redirects.
                raise VoiceError('ENGINE_REJECTED', 'PC 엔진이 생성하지 못했습니다. 모델 설정과 참고 음성의 읽은 문장을 확인해 주세요.', 502) from None
            except (TimeoutError, OSError, URLError):
                # A disconnected request is not proof that GPU inference stopped.
                self.uncertain = True
                raise VoiceError('ENGINE_RESTART_REQUIRED', 'PC 엔진의 응답을 끝까지 받지 못했습니다. 엔진과 편집기 서버를 다시 실행한 뒤 짧은 원고로 시도해 주세요.', 503) from None

    def require_engine(self):
        if not verified_engine(self.opener, self.endpoint, self.engine_headers.get('X-Studio-Engine-Key')):
            raise VoiceError('ENGINE_NOT_READY', '안전한 PC 음성 엔진 연결을 확인하지 못했습니다. PC 음성 시작 후 연결을 다시 확인해 주세요.', 503)
