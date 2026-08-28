"""허용한 편집기와 이 PC 엔진만 연결하는 루프백 승인·인증 계층입니다."""
import hashlib
import hmac
import html
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time

BRIDGE_PORT = 8792
BRIDGE_VERSION = 1
PUBLIC_ORIGINS = frozenset({
    'https://shorts-studio-75p.pages.dev',
    'https://codex-studio-lab.shorts-studio-75p.pages.dev',
})
ID = re.compile(r'^[a-f0-9]{32}$')
SECRET = re.compile(r'^[A-Za-z0-9_-]{43}$')
MAX_PAIRINGS = 24
PAIR_TTL = 180


class BridgeError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


class PcBridgeService:
    def __init__(self, local, clock=time.time):
        self.local = Path(local)
        self.clock = clock
        self.lock = threading.RLock()
        self.pending = {}

    def management_key(self, create=False):
        """설치 실행기만 읽는 관리 키입니다. 브라우저 연결 토큰과는 별개입니다."""
        path = self.local / 'pc-bridge-key.json'
        try:
            if path.is_symlink() or path.stat().st_size > 1024:
                return None
            key = json.loads(path.read_text(encoding='ascii')).get('key')
            return key if isinstance(key, str) and re.fullmatch(r'[a-f0-9]{64}', key) else None
        except FileNotFoundError:
            if not create:
                return None
            self.local.mkdir(parents=True, exist_ok=True)
            try:
                with path.open('x', encoding='ascii') as stream:
                    json.dump({'key': secrets.token_hex(32)}, stream)
                if os.name != 'nt':
                    path.chmod(0o600)
            except FileExistsError:
                pass
            return self.management_key()
        except (OSError, ValueError, AttributeError):
            return None

    def health(self, nonce):
        key = self.management_key()
        if not isinstance(nonce, str) or not ID.fullmatch(nonce) or not key:
            raise BridgeError('BRIDGE_IDENTITY', 'PC 연결 프로그램의 신원을 확인하지 못했습니다.', 403)
        proof = hmac.new(key.encode('ascii'), ('studio-pc-bridge-v1:' + nonce).encode('ascii'), hashlib.sha256).hexdigest()
        return {'provider': 'shorts-studio-pc-bridge', 'version': BRIDGE_VERSION, 'nonce': nonce, 'proof': proof}

    def management_allowed(self, supplied):
        key = self.management_key()
        return isinstance(supplied, str) and key is not None and hmac.compare_digest(key, supplied)

    def _tokens(self):
        path = self.local / 'browser-connections.json'
        try:
            if path.is_symlink() or path.stat().st_size > 32768:
                return []
            data = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('connections'), list):
                return []
            return [row for row in data['connections'][-MAX_PAIRINGS:]
                    if isinstance(row, dict) and row.get('origin') in PUBLIC_ORIGINS
                    and isinstance(row.get('digest'), str) and re.fullmatch(r'[a-f0-9]{64}', row['digest'])
                    and isinstance(row.get('created'), (int, float))]
        except (OSError, ValueError, TypeError):
            return []

    def authorized(self, origin, authorization):
        if origin not in PUBLIC_ORIGINS or not isinstance(authorization, str) or not authorization.startswith('Bearer '):
            return False
        token = authorization[7:]
        if not SECRET.fullmatch(token):
            return False
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.lock:
            return any(row['origin'] == origin and hmac.compare_digest(row['digest'], digest) for row in self._tokens())

    def _prune(self):
        now = self.clock()
        self.pending = {key: row for key, row in self.pending.items() if row['expires'] > now}

    def begin(self, origin):
        if origin not in PUBLIC_ORIGINS:
            raise BridgeError('ORIGIN_DENIED', '허용된 Shorts Studio 주소에서만 연결할 수 있습니다.', 403)
        with self.lock:
            self._prune()
            if len(self.pending) >= 16 or sum(row['origin'] == origin for row in self.pending.values()) >= 4:
                raise BridgeError('PAIR_LIMIT', '이미 연결 확인 창이 열려 있습니다. 잠시 뒤 다시 시도해 주세요.', 429)
            request_id, secret = secrets.token_hex(16), secrets.token_urlsafe(32)
            self.pending[request_id] = {'origin': origin, 'secret': secret, 'csrf': secrets.token_urlsafe(32),
                                        'expires': self.clock() + PAIR_TTL, 'token': None}
            return {'requestId': request_id, 'requestSecret': secret,
                    'approvalPath': '/pc-connect.html?request=' + request_id, 'expiresIn': PAIR_TTL}

    def _pending(self, request_id):
        self._prune()
        if not isinstance(request_id, str) or not ID.fullmatch(request_id) or request_id not in self.pending:
            raise BridgeError('PAIR_EXPIRED', '연결 확인 시간이 지났습니다. 편집기에서 PC 연결을 다시 눌러 주세요.', 410)
        return self.pending[request_id]

    def page(self, request_id):
        with self.lock:
            row = self._pending(request_id)
            body = '<h1>이 편집기에 PC 연결을 허용할까요?</h1><p class="origin">' + html.escape(row['origin']) + '</p>'
            body += '<p>이 주소의 편집기가 설치된 음성·자막·영상 추적 엔진을 사용할 수 있습니다. 실행한 작업만 이 PC에서 처리합니다.</p>'
            body += '<p>한 번 허용하면 브라우저를 다시 열어도 연결을 기억합니다. 도움말에서 연결을 해제할 수 있습니다.</p>'
            body += '<form method="post" action="/api/pc-bridge/approve"><input type="hidden" name="requestId" value="' + request_id + '">'
            body += '<input type="hidden" name="csrf" value="' + row['csrf'] + '"><button type="submit">이 편집기에 연결 허용</button></form>'
            return connection_page(body)

    def approve(self, request_id, csrf):
        with self.lock:
            row = self._pending(request_id)
            if not isinstance(csrf, str) or not hmac.compare_digest(csrf, row['csrf']):
                raise BridgeError('PAIR_CSRF', '연결 확인 창에서 다시 승인해 주세요.', 403)
            if row['token'] is None:
                token = secrets.token_urlsafe(32)
                entries = self._tokens()
                entries.append({'origin': row['origin'], 'digest': hashlib.sha256(token.encode()).hexdigest(), 'created': self.clock()})
                self.local.mkdir(parents=True, exist_ok=True)
                target = self.local / 'browser-connections.json'
                if target.is_symlink():
                    raise BridgeError('PAIR_STORAGE', 'PC 연결 저장소를 확인해 주세요.', 500)
                temporary = target.with_suffix('.json.tmp')
                if temporary.is_symlink():
                    raise BridgeError('PAIR_STORAGE', 'PC 연결 저장소를 확인해 주세요.', 500)
                temporary.write_text(json.dumps({'version': 1, 'connections': entries[-MAX_PAIRINGS:]}), encoding='utf-8')
                temporary.replace(target)
                row['token'] = token
            return connection_page('<h1>PC 연결을 허용했어요.</h1><p>원래 편집기로 돌아가세요. 설치 상태가 자동으로 표시됩니다.</p><p>이 창은 닫아도 됩니다.</p>')

    def result(self, origin, request_id, secret):
        with self.lock:
            row = self._pending(request_id)
            if row['origin'] != origin or not isinstance(secret, str) or not hmac.compare_digest(secret, row['secret']):
                raise BridgeError('PAIR_DENIED', '이 편집기의 연결 요청이 아닙니다.', 403)
            return {'state': 'approved', 'token': row['token'], 'version': BRIDGE_VERSION} if row['token'] else {'state': 'pending'}

    def revoke(self, origin, authorization):
        if not self.authorized(origin, authorization):
            raise BridgeError('PAIR_REQUIRED', '연결된 편집기에서 해제해 주세요.', 401)
        digest = hashlib.sha256(authorization[7:].encode()).hexdigest()
        with self.lock:
            target = self.local / 'browser-connections.json'
            rows = [row for row in self._tokens() if not (row['origin'] == origin and hmac.compare_digest(row['digest'], digest))]
            temporary = target.with_suffix('.json.tmp')
            if target.is_symlink() or temporary.is_symlink():
                raise BridgeError('PAIR_STORAGE', 'PC 연결 저장소를 확인해 주세요.', 500)
            temporary.write_text(json.dumps({'version': 1, 'connections': rows}), encoding='utf-8')
            temporary.replace(target)


def connection_page(body):
    return ('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>Shorts Studio · PC 연결</title><style>body{font:16px/1.7 system-ui,sans-serif;background:#121616;color:#ecf0ed;margin:0;padding:40px 24px}'
            'main{max-width:540px;margin:auto}h1{font-size:25px}.origin{overflow-wrap:anywhere;color:#b8ea75}p{color:#b8c5bd}'
            'button{font:700 16px system-ui;border:0;border-radius:10px;padding:16px 24px;background:#b8ea75;color:#182414;cursor:pointer;width:100%}</style>'
            '<main>' + body + '</main></html>').encode('utf-8')
