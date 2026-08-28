"""숏츠 스튜디오 실험판. 이 PC의 루프백 주소에서만 제공합니다."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from threading import BoundedSemaphore, Lock
from collections import deque
import argparse, json, os, time, uuid, math
from pc_voice import VoiceCloneService, VoiceError, MAX_REFERENCE_BODY
from pc_voice_config import PROVIDERS, service_identity
from pc_asr import PcAsrService, AsrError, MAX_AUDIO_BYTES
from pc_installation import local_data_dir
from pc_bridge import PcBridgeService
from pc_http import PcHttpMixin
from pc_runtime import PcVoiceRuntime
from pc_tracking import PcTrackingService

ROOT = Path(__file__).resolve().parent / 'public'
VOICES = ('alloy','ash','ballad','coral','echo','fable','onyx','nova','sage','shimmer','verse','marin','cedar')
AI_LOCK = BoundedSemaphore(1)
RATE_LOCK = Lock()
REQUEST_TIMES = deque()
LOCAL_VOICE_DIR = local_data_dir(Path(__file__).resolve().parent)
def configured_pc_voice(port=9880, provider='auto'):
    selected, key = service_identity(LOCAL_VOICE_DIR, provider)
    return VoiceCloneService(LOCAL_VOICE_DIR / 'voices', port=port, engine_key=key, provider=selected)

PC_VOICE = configured_pc_voice()
PC_ASR = PcAsrService(LOCAL_VOICE_DIR, voice=PC_VOICE)
PC_BRIDGE = PcBridgeService(LOCAL_VOICE_DIR)
PC_TRACKING = PcTrackingService(LOCAL_VOICE_DIR, voice=PC_VOICE)

def validate_tts(data):
    """요청 모델·목소리·입력 길이를 제한합니다. 임의 URL 프록시는 제공하지 않습니다."""
    if not isinstance(data, dict):
        raise ValueError('원고 정보가 올바르지 않습니다.')
    text = data.get('text', '')
    voice = data.get('voice', 'marin')
    instructions = data.get('instructions', '')
    speed = data.get('speed', 1)
    if not isinstance(text, str) or not text.strip() or len(text) > 2000:
        raise ValueError('원고는 1~2,000자로 입력해 주세요.')
    if voice not in VOICES:
        raise ValueError('지원하지 않는 보이스입니다.')
    if not isinstance(instructions, str) or len(instructions) > 1000:
        raise ValueError('말하기 스타일은 1,000자 이내여야 합니다.')
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not math.isfinite(speed) or not .75 <= speed <= 1.25:
        raise ValueError('속도는 0.75~1.25 사이여야 합니다.')
    return {'model': 'gpt-4o-mini-tts', 'input': text.strip(), 'voice': voice,
            'instructions': instructions, 'speed': speed, 'response_format': 'wav'}

def transcription_body(audio):
    """타임코드는 추정하지 않고 whisper-1의 단어/구간 시각을 받습니다."""
    boundary = 'studio-' + uuid.uuid4().hex
    parts = []
    fields = [('model','whisper-1'),('language','ko'),('response_format','verbose_json'),
              ('timestamp_granularities[]','word'),('timestamp_granularities[]','segment')]
    for key, value in fields:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode())
    parts.extend([audio, f'\r\n--{boundary}--\r\n'.encode()])
    return b''.join(parts), f'multipart/form-data; boundary={boundary}'

class StudioHandler(PcHttpMixin, SimpleHTTPRequestHandler):
    # Windows의 파일 연결 설정과 무관하게 브라우저 모듈과 WASM을 올바르게 제공합니다.
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript',
                      '.wasm': 'application/wasm'}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.pc_cors_headers()
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        super().end_headers()

    def log_message(self, fmt, *args):
        # 원고, 음성, 인증 헤더, URL 매개변수는 기록하지 않습니다.
        print(f'{self.command} {urlsplit(self.path).path} {args[1] if len(args) > 1 else ""}', flush=True)

    def local_host(self):
        port = self.server.server_port
        return self.headers.get('Host') in (f'127.0.0.1:{port}', f'localhost:{port}')

    def json_response(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def error_response(self, status, code, message):
        self.json_response(status, {'error': {'code': code, 'message': message}})

    def do_GET(self):
        if not self.local_host():
            self.error_response(403, 'LOCAL_ONLY', '이 PC의 로컬 주소에서만 접근할 수 있습니다.')
            return
        route = urlsplit(self.path).path
        if self.pc_extra_get(route):
            return
        if route.startswith('/api/pc-asr/'):
            if not self.asr_request_allowed():
                return
            try:
                service = self.pc_asr_service()
                if route == '/api/pc-asr/status':
                    self.json_response(200, service.status())
                elif route.startswith('/api/pc-asr/jobs/'):
                    self.json_response(200, service.get(route.removeprefix('/api/pc-asr/jobs/')))
                else:
                    self.error_response(404, 'NOT_FOUND', '지원하지 않는 PC 자막 기능입니다.')
            except AsrError as error:
                self.error_response(error.status, error.code, error.message)
            return
        if urlsplit(self.path).path == '/api/voice-clone/status':
            if not self.pc_request_allowed():
                return
            runtime = getattr(self.server, 'pc_runtime', None)
            self.json_response(200, runtime.status() if runtime else self.pc_voice_service().status())
            return
        if urlsplit(self.path).path == '/api/ai/status':
            self.json_response(200, {'configured': bool(os.environ.get('OPENAI_API_KEY')),
                                    'verified': False, 'provider': 'openai', 'ttsModel': 'gpt-4o-mini-tts',
                                    'voices': VOICES, 'externalTransmissionRequiresConfirmation': True})
            return
        if urlsplit(self.path).path == '/':
            self.path = '/studio.html'
        super().do_GET()

    def pc_voice_service(self):
        return getattr(self.server, 'pc_voice', PC_VOICE)

    def pc_asr_service(self):
        return getattr(self.server, 'pc_asr', PC_ASR)

    def pc_bridge_service(self):
        return getattr(self.server, 'pc_bridge', PC_BRIDGE)

    def pc_tracking_service(self):
        return getattr(self.server, 'pc_tracking', PC_TRACKING)

    def asr_request_allowed(self):
        return self.pc_authorized('X-Studio-PC-ASR')

    def handle_pc_asr(self, route):
        if not self.asr_request_allowed():
            return
        if self.headers.get('X-Studio-Consent') != 'audio-to-local-asr':
            self.error_response(403, 'ASR_CONSENT_REQUIRED', '오디오를 이 PC에서만 처리하는 안내를 확인해 주세요.')
            return
        if route not in ('/api/pc-asr/transcribe', '/api/pc-asr/cancel'):
            self.error_response(404, 'NOT_FOUND', '지원하지 않는 PC 자막 기능입니다.')
            return
        maximum = MAX_AUDIO_BYTES if route.endswith('/transcribe') else 1024
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if self.headers.get('Transfer-Encoding') or not 0 < length <= maximum:
            self.error_response(413, 'PAYLOAD_LIMIT', '음성이 비어 있거나 3분 입력 제한을 초과했습니다.')
            return
        expected = 'audio/wav' if route.endswith('/transcribe') else 'application/json'
        if self.headers.get('Content-Type', '').split(';')[0].strip() != expected:
            self.error_response(415, 'CONTENT_TYPE', 'PC 자막 입력 형식을 확인해 주세요.')
            return
        try:
            self.connection.settimeout(30)
            body = self.rfile.read(length)
            if len(body) != length:
                raise AsrError('INCOMPLETE_BODY', '음성 요청을 끝까지 받지 못했습니다.')
            service = self.pc_asr_service()
            if route.endswith('/transcribe'):
                self.json_response(202, {'jobId': service.start(body)})
            else:
                data = json.loads(body)
                if not isinstance(data, dict) or set(data) != {'jobId'}:
                    raise ValueError()
                self.json_response(200, {'cancelled': service.cancel(data.get('jobId'))})
        except AsrError as error:
            self.error_response(error.status, error.code, error.message)
        except (ValueError, UnicodeError, TypeError):
            self.error_response(400, 'INVALID_INPUT', 'PC 자막 요청을 확인해 주세요.')
        except (BrokenPipeError, ConnectionResetError):
            pass
        except TimeoutError:
            self.error_response(408, 'REQUEST_TIMEOUT', '음성 요청을 끝까지 받지 못했습니다.')
        except OSError:
            self.error_response(500, 'ASR_LOCAL_ERROR', 'PC 자막 실행 환경에 접근하지 못했습니다.')

    def pc_request_allowed(self):
        return self.pc_authorized('X-Studio-PC-Voice')

    def handle_pc_voice(self, route):
        if not self.pc_request_allowed():
            return
        if self.headers.get('X-Studio-Consent') != 'voice-clone-local':
            self.error_response(403, 'VOICE_CONSENT_REQUIRED', '참고 음성의 PC 저장·처리 안내를 확인해 주세요.')
            return
        if route not in ('/api/voice-clone/references', '/api/voice-clone/delete', '/api/voice-clone/synthesize'):
            self.error_response(404, 'NOT_FOUND', '지원하지 않는 PC 음성 기능입니다.')
            return
        maximum = MAX_REFERENCE_BODY if route.endswith('/references') else 32 * 1024
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if self.headers.get('Transfer-Encoding') or not 0 < length <= maximum:
            self.error_response(413, 'PAYLOAD_LIMIT', '음성 요청이 비어 있거나 허용 크기를 초과했습니다.')
            return
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            self.error_response(415, 'CONTENT_TYPE', '지원하지 않는 PC 음성 입력 형식입니다.')
            return
        try:
            self.connection.settimeout(30)
            body = self.rfile.read(length)
            if len(body) != length:
                raise VoiceError('INCOMPLETE_BODY', '음성 요청을 끝까지 받지 못했습니다.')
            data = json.loads(body)
            if not isinstance(data, dict):
                raise ValueError()
            service = self.pc_voice_service()
            if route.endswith('/references'):
                self.json_response(201, {'profile': service.register(data)})
            elif route.endswith('/delete'):
                if data.get('consent') is not True:
                    raise VoiceError('VOICE_CONSENT_REQUIRED', '참고 음성 삭제를 확인해 주세요.', 403)
                service.delete(data.get('profileId'))
                self.json_response(200, {'deleted': True})
            else:
                result, info = service.synthesize(data)
                self.send_response(200)
                self.send_header('Content-Type', 'audio/wav')
                self.send_header('Content-Length', str(len(result)))
                self.send_header('X-Studio-Audio-Rate', str(info['sampleRate']))
                self.send_header('X-Studio-Audio-Duration', str(info['duration']))
                self.end_headers()
                self.wfile.write(result)
        except VoiceError as error:
            self.error_response(error.status, error.code, error.message)
        except (ValueError, UnicodeError, TypeError):
            self.error_response(400, 'INVALID_INPUT', 'PC 음성 요청을 확인해 주세요.')
        except (BrokenPipeError, ConnectionResetError):
            # Browser cancellation discards the result; the engine request has
            # already finished before its exclusive lock is released.
            pass
        except TimeoutError:
            self.error_response(408, 'REQUEST_TIMEOUT', '음성 요청을 끝까지 받지 못했습니다.')
        except OSError:
            self.error_response(500, 'LOCAL_STORAGE', 'PC 음성 저장소에 접근하지 못했습니다.')

    def do_POST(self):
        route = urlsplit(self.path).path
        if self.pc_extra_post(route):
            return
        if route.startswith('/api/pc-asr/'):
            self.handle_pc_asr(route)
            return
        if route.startswith('/api/voice-clone/'):
            self.handle_pc_voice(route)
            return
        port = self.server.server_port
        if not self.local_host() or self.headers.get('Origin') not in (f'http://127.0.0.1:{port}', f'http://localhost:{port}'):
            self.error_response(403, 'CROSS_ORIGIN_BLOCKED', '편집기 화면에서 요청해 주세요.')
            return
        if route not in ('/api/tts', '/api/transcribe'):
            self.error_response(404, 'NOT_FOUND', '지원하지 않는 API 경로입니다.')
            return
        consent = 'text-to-openai' if route == '/api/tts' else 'audio-to-openai'
        if self.headers.get('X-Studio-Consent') != consent:
            self.error_response(403, 'CONSENT_REQUIRED', '외부 전송 내용을 확인한 뒤 다시 실행해 주세요.')
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        maximum = 64 * 1024 if route == '/api/tts' else 22 * 1024 * 1024
        if not 0 < length <= maximum:
            self.error_response(413, 'PAYLOAD_LIMIT', '요청이 비어 있거나 허용 크기를 초과했습니다.')
            return
        content_type = self.headers.get('Content-Type', '').split(';')[0]
        expected = 'application/json' if route == '/api/tts' else 'audio/wav'
        if content_type != expected:
            self.error_response(415, 'CONTENT_TYPE', '지원하지 않는 입력 형식입니다.')
            return
        self.connection.settimeout(30)
        body = self.rfile.read(length)
        if len(body) != length:
            self.error_response(400, 'INCOMPLETE_BODY', '요청 파일을 끝까지 받지 못했습니다.')
            return
        try:
            if route == '/api/tts':
                payload = json.dumps(validate_tts(json.loads(body))).encode('utf-8')
                upstream_type = 'application/json'
                endpoint = 'https://api.openai.com/v1/audio/speech'
            else:
                if len(body) < 44 or body[:4] != b'RIFF' or body[8:12] != b'WAVE':
                    raise ValueError('WAV 오디오를 확인해 주세요.')
                payload, upstream_type = transcription_body(body)
                endpoint = 'https://api.openai.com/v1/audio/transcriptions'
        except (ValueError, UnicodeError, TypeError):
            self.error_response(400, 'INVALID_INPUT', '원고·보이스·속도 또는 음성 파일이 올바르지 않습니다.')
            return
        key = os.environ.get('OPENAI_API_KEY')
        if not key:
            self.error_response(503, 'AI_NOT_CONFIGURED', 'AI 연결이 필요합니다. 로컬 서버 환경에 OPENAI_API_KEY를 설정한 뒤 서버를 다시 실행해 주세요.')
            return
        with RATE_LOCK:
            now = time.monotonic()
            while REQUEST_TIMES and now - REQUEST_TIMES[0] > 60:
                REQUEST_TIMES.popleft()
            if len(REQUEST_TIMES) >= 6:
                self.error_response(429, 'LOCAL_RATE_LIMIT', '요청이 많습니다. 잠시 뒤 다시 시도해 주세요.')
                return
            REQUEST_TIMES.append(now)
        if not AI_LOCK.acquire(blocking=False):
            self.error_response(429, 'REQUEST_IN_PROGRESS', '다른 AI 요청이 처리 중입니다. 완료 후 다시 실행해 주세요.')
            return
        try:
            request = Request(endpoint, data=payload, headers={'Authorization': 'Bearer ' + key, 'Content-Type': upstream_type}, method='POST')
            with urlopen(request, timeout=60) as response:
                result = response.read(32 * 1024 * 1024 + 1)
            if len(result) > 32 * 1024 * 1024:
                self.error_response(502, 'RESPONSE_LIMIT', '생성 결과가 너무 큽니다. 원고를 나누어 주세요.')
                return
            if route == '/api/transcribe':
                data = json.loads(result)
                self.json_response(200, {key: data.get(key, [] if key != 'text' else '') for key in ('text','segments','words')})
            else:
                if len(result) < 44 or result[:4] != b'RIFF' or result[8:12] != b'WAVE':
                    self.error_response(502, 'EMPTY_AUDIO', '음성 결과를 받지 못했습니다.')
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'audio/wav')
                self.send_header('Content-Length', str(len(result)))
                self.end_headers()
                self.wfile.write(result)
        except HTTPError as error:
            messages = {401: 'AI 인증 설정을 확인해 주세요.', 403: '이 API에 접근할 권한이 없습니다.', 429: 'AI 사용량 또는 속도 제한에 도달했습니다.'}
            self.error_response(error.code if error.code in messages else 502, 'UPSTREAM_ERROR', messages.get(error.code, 'AI 서비스가 요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'))
        except (URLError, TimeoutError, ValueError):
            self.error_response(502, 'UPSTREAM_UNAVAILABLE', 'AI 서비스에 연결하지 못했습니다. 네트워크와 서버 설정을 확인해 주세요.')
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            AI_LOCK.release()

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8787)
    parser.add_argument('--voice-port', type=int, default=9880, help='Private voice engine loopback port (default 9880)')
    parser.add_argument('--voice-provider', choices=('auto', *PROVIDERS), default='auto')
    args = parser.parse_args()
    print(f'Local: http://127.0.0.1:{args.port}', flush=True)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), StudioHandler)
    server.pc_voice = configured_pc_voice(args.voice_port, args.voice_provider)
    server.pc_asr = PcAsrService(LOCAL_VOICE_DIR, voice=server.pc_voice)
    server.pc_bridge = PcBridgeService(LOCAL_VOICE_DIR)
    if server.pc_bridge.management_key(create=True) is None:
        raise RuntimeError('PC bridge management storage is unavailable')
    server.pc_tracking = PcTrackingService(LOCAL_VOICE_DIR, voice=server.pc_voice)
    server.pc_runtime = PcVoiceRuntime(LOCAL_VOICE_DIR, server.pc_voice, args.voice_port, args.voice_provider)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.pc_asr.close()
        server.pc_tracking.close()
        server.pc_runtime.close()
        server.server_close()
