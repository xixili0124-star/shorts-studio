"""승인한 공개 편집기와 로컬 편집기에서만 PC 기능을 호출합니다."""
import json
import threading
from urllib.parse import parse_qs, urlsplit

from pc_bridge import PUBLIC_ORIGINS, BRIDGE_VERSION, BridgeError
from pc_tracking import TrackingError, MAX_VIDEO_BYTES
from pc_voice import VoiceError

PC_PREFIXES = ('/api/pc-bridge/', '/api/pc-asr/', '/api/voice-clone/', '/api/pc-tracking/')
ALLOWED_HEADERS = frozenset({
    'authorization', 'content-type', 'x-studio-pc-bridge', 'x-studio-pc-asr',
    'x-studio-pc-voice', 'x-studio-pc-tracking', 'x-studio-consent', 'x-studio-tracking-options',
})


class PcHttpMixin:
    def pc_cors_headers(self):
        origin = self.headers.get('Origin')
        if self.local_host() and origin in PUBLIC_ORIGINS and urlsplit(self.path).path.startswith(PC_PREFIXES):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Expose-Headers', 'X-Studio-Audio-Rate, X-Studio-Audio-Duration')

    def do_OPTIONS(self):
        requested = self.headers.get('Access-Control-Request-Headers', '')
        headers = {item.strip().lower() for item in requested.split(',') if item.strip()}
        if (not self.local_host() or self.headers.get('Origin') not in PUBLIC_ORIGINS
                or not urlsplit(self.path).path.startswith(PC_PREFIXES)
                or self.headers.get('Access-Control-Request-Method') not in ('GET', 'POST')
                or not headers.issubset(ALLOWED_HEADERS)):
            self.error_response(403, 'CROSS_ORIGIN_BLOCKED', '허용되지 않은 PC 연결 요청입니다.')
            return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST')
        self.send_header('Access-Control-Allow-Headers', ', '.join(sorted(headers)))
        # 브라우저의 로컬 네트워크 허용 절차를 우회하지 않습니다.
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Access-Control-Max-Age', '300')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def same_local_origin(self):
        allowed = (f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}')
        origin = self.headers.get('Origin')
        return (self.local_host() and (origin in allowed or (self.command == 'GET' and origin is None))
                and self.headers.get('Sec-Fetch-Site') != 'cross-site')

    def pc_authorized(self, header):
        origin = self.headers.get('Origin')
        allowed = self.same_local_origin() or (
            origin in PUBLIC_ORIGINS and self.pc_bridge_service().authorized(origin, self.headers.get('Authorization')))
        if not self.local_host() or self.headers.get(header) != '1' or not allowed:
            self.error_response(403, 'PC_CONNECTION_REQUIRED', '도움말에서 이 편집기의 PC 연결을 허용해 주세요.')
            return False
        return self.pc_accepting()

    def pc_accepting(self):
        """종료 장벽 뒤의 요청은 본문 업로드나 상태 기반 재실행 전에 거절한다."""
        voice = self.pc_voice_service()
        runtime = getattr(self.server, 'pc_runtime', None)
        if voice.closed or runtime is not None and (runtime.stopping or runtime.closed):
            self.error_response(503, 'PC_STOPPING', 'PC 연결 프로그램이 종료 중입니다. 다시 연결한 뒤 실행해 주세요.')
            return False
        if self.command == 'POST' and voice.uncertain:
            self.error_response(503, 'ENGINE_RESTART_REQUIRED', '이전 PC 작업의 종료를 확인하지 못했습니다. 실행기를 완전히 종료해 주세요.')
            return False
        return True

    def read_pc_body(self, maximum, expected):
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if self.headers.get('Transfer-Encoding') or not 0 < length <= maximum:
            raise BridgeError('PAYLOAD_LIMIT', '요청이 비어 있거나 허용 크기를 초과했습니다.', 413)
        if self.headers.get('Content-Type', '').split(';')[0].strip().lower() not in expected:
            raise BridgeError('CONTENT_TYPE', 'PC 기능의 입력 형식을 확인해 주세요.', 415)
        self.connection.settimeout(60)
        body = self.rfile.read(length)
        if len(body) != length:
            raise BridgeError('INCOMPLETE_BODY', '요청을 끝까지 받지 못했습니다.')
        return body

    def pc_html(self, content):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(content)))
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(content)

    def pc_bridge_status(self):
        runtime = getattr(self.server, 'pc_runtime', None)
        voice = runtime.status() if runtime else self.pc_voice_service().status()
        # 연결 요약에는 참고 음성 내용이나 설치 경로를 포함하지 않습니다.
        voice = {key: voice[key] for key in ('provider', 'modelName', 'state', 'message', 'configured') if key in voice}
        return {'app': 'shorts-studio-pc', 'version': BRIDGE_VERSION, 'engines': {
            'voice': voice, 'asr': self.pc_asr_service().status(), 'tracking': self.pc_tracking_service().status()}}

    def pc_extra_get(self, route):
        if route == '/api/pc-bridge/health':
            try:
                if self.headers.get('Origin') or self.headers.get('Sec-Fetch-Site'):
                    raise BridgeError('BRIDGE_IDENTITY', '설치 실행기 전용 확인입니다.', 403)
                self.json_response(200, self.pc_bridge_service().health(self.headers.get('X-Studio-Bridge-Nonce')))
            except BridgeError as error:
                self.error_response(error.status, error.code, error.message)
            return True
        if route == '/pc-connect.html':
            try:
                query = parse_qs(urlsplit(self.path).query, max_num_fields=4)
                self.pc_html(self.pc_bridge_service().page(query.get('request', [''])[0]))
            except (ValueError, BridgeError) as error:
                self.error_response(getattr(error, 'status', 400), getattr(error, 'code', 'PAIR_INVALID'),
                                    getattr(error, 'message', '연결 요청을 확인해 주세요.'))
            return True
        if route == '/api/pc-bridge/status':
            if self.pc_authorized('X-Studio-PC-Bridge'):
                self.json_response(200, self.pc_bridge_status())
            return True
        if route.startswith('/api/pc-tracking/'):
            if not self.pc_authorized('X-Studio-PC-Tracking'):
                return True
            try:
                service = self.pc_tracking_service()
                if route == '/api/pc-tracking/status':
                    self.json_response(200, service.status())
                elif route.startswith('/api/pc-tracking/jobs/'):
                    self.json_response(200, service.get(route.removeprefix('/api/pc-tracking/jobs/')))
                else:
                    self.error_response(404, 'NOT_FOUND', '지원하지 않는 PC 추적 기능입니다.')
            except TrackingError as error:
                self.error_response(error.status, error.code, error.message)
            return True
        if route.startswith('/api/pc-bridge/'):
            self.error_response(404, 'NOT_FOUND', '지원하지 않는 PC 연결 기능입니다.')
            return True
        return False

    def pc_extra_post(self, route):
        if not route.startswith(('/api/pc-bridge/', '/api/pc-tracking/')):
            return False
        try:
            if not self.local_host():
                raise BridgeError('LOCAL_ONLY', '이 PC의 로컬 주소에서만 접근할 수 있습니다.', 403)
            bridge, origin = self.pc_bridge_service(), self.headers.get('Origin')
            if route == '/api/pc-bridge/shutdown':
                if origin is not None or self.headers.get('Sec-Fetch-Site') is not None or not bridge.management_allowed(self.headers.get('X-Studio-Bridge-Key')):
                    raise BridgeError('BRIDGE_MANAGEMENT', '설치 실행기에서만 PC 연결 프로그램을 재시작할 수 있습니다.', 403)
                if json.loads(self.read_pc_body(128, ('application/json',))) != {}:
                    raise ValueError()
                runtime = getattr(self.server, 'pc_runtime', None)
                if runtime is None:
                    raise BridgeError('PC_RUNTIME_UNAVAILABLE', 'PC 연결 실행기를 다시 시작해 주세요.', 503)
                runtime.prepare_shutdown(self.pc_asr_service(), self.pc_tracking_service())
                try:
                    self.json_response(200, {'stopping': True})
                finally:
                    # 승인 뒤 브라우저나 설치 실행기의 연결이 끊겨도 종료를 진행한다.
                    threading.Thread(target=self.server.shutdown, daemon=True).start()
                return True
            if not self.pc_accepting():
                return True
            if route == '/api/pc-bridge/approve':
                if not self.same_local_origin():
                    raise BridgeError('PAIR_DENIED', 'PC 연결 확인 창에서 승인해 주세요.', 403)
                data = parse_qs(self.read_pc_body(1024, ('application/x-www-form-urlencoded',)).decode('utf-8'), max_num_fields=2, strict_parsing=True)
                if set(data) != {'requestId', 'csrf'} or any(len(values) != 1 for values in data.values()):
                    raise ValueError()
                self.pc_html(bridge.approve(data['requestId'][0], data['csrf'][0]))
                return True
            if route in ('/api/pc-bridge/pair/start', '/api/pc-bridge/pair/result'):
                if origin not in PUBLIC_ORIGINS or self.headers.get('X-Studio-PC-Bridge') != '1':
                    raise BridgeError('ORIGIN_DENIED', '허용된 편집기에서 PC 연결을 눌러 주세요.', 403)
                data = json.loads(self.read_pc_body(1024, ('application/json',)))
                if not isinstance(data, dict):
                    raise ValueError()
                if route.endswith('/start'):
                    if data:
                        raise ValueError()
                    self.json_response(201, bridge.begin(origin))
                else:
                    if set(data) != {'requestId', 'requestSecret'}:
                        raise ValueError()
                    self.json_response(200, bridge.result(origin, data['requestId'], data['requestSecret']))
                return True
            if route.startswith('/api/pc-bridge/'):
                if not self.pc_authorized('X-Studio-PC-Bridge'):
                    return True
                if route == '/api/pc-bridge/revoke':
                    bridge.revoke(origin, self.headers.get('Authorization'))
                    self.json_response(200, {'revoked': True})
                else:
                    self.error_response(404, 'NOT_FOUND', '지원하지 않는 PC 연결 기능입니다.')
                return True
            if not self.pc_authorized('X-Studio-PC-Tracking'):
                return True
            if self.headers.get('X-Studio-Consent') != 'video-to-local-tracking':
                raise BridgeError('TRACKING_CONSENT_REQUIRED', '영상을 이 PC에서 처리하는 안내를 확인해 주세요.', 403)
            service = self.pc_tracking_service()
            if route == '/api/pc-tracking/track':
                raw_options = self.headers.get('X-Studio-Tracking-Options', '')
                if len(raw_options) > 2048:
                    raise ValueError()
                options = json.loads(raw_options)
                body = self.read_pc_body(MAX_VIDEO_BYTES, ('video/mp4', 'video/quicktime', 'video/webm', 'application/octet-stream'))
                self.json_response(202, {'jobId': service.start(body, options)})
            elif route == '/api/pc-tracking/cancel':
                data = json.loads(self.read_pc_body(1024, ('application/json',)))
                if not isinstance(data, dict) or set(data) != {'jobId'}:
                    raise ValueError()
                self.json_response(200, {'cancelled': service.cancel(data['jobId'])})
            else:
                self.error_response(404, 'NOT_FOUND', '지원하지 않는 PC 추적 기능입니다.')
        except (BridgeError, TrackingError, VoiceError) as error:
            self.error_response(error.status, error.code, error.message)
        except (ValueError, TypeError, UnicodeError):
            self.error_response(400, 'INVALID_INPUT', 'PC 기능의 요청을 확인해 주세요.')
        except (BrokenPipeError, ConnectionResetError):
            pass
        except TimeoutError:
            self.error_response(408, 'REQUEST_TIMEOUT', 'PC 연결 요청을 끝까지 받지 못했습니다.')
        except OSError:
            self.error_response(500, 'PC_LOCAL_ERROR', 'PC 설치 또는 연결 저장소를 확인해 주세요.')
        return True
