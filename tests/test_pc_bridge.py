"""사용자 녹음·실제 엔진 없이 임시 저장소와 루프백 HTTP로 PC 연결을 검사합니다."""
import hashlib
import hmac
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.parse import urlencode
from urllib.error import URLError

from pc_bridge import PcBridgeService, BridgeError, PUBLIC_ORIGINS, PAIR_TTL, MAX_PAIRINGS
from pc_voice import VoiceCloneService, VoiceError, verified_engine
from pc_voice_engine import EngineASRReservation
import pc_installation
import pc_runtime

SITE = 'https://shorts-studio-75p.pages.dev'
LAB = 'https://codex-studio-lab.shorts-studio-75p.pages.dev'


def csrf_from(page):
    return re.search(rb'name="csrf" value="([A-Za-z0-9_-]+)"', page)[1].decode('ascii')


class BridgeServiceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='studio-bridge-unit-')
        self.addCleanup(temporary.cleanup)
        self.local = Path(temporary.name)
        self.now = 1000
        self.bridge = PcBridgeService(self.local, clock=lambda: self.now)

    def approve(self, origin=SITE):
        pending = self.bridge.begin(origin)
        self.bridge.approve(pending['requestId'], csrf_from(self.bridge.page(pending['requestId'])))
        return pending, self.bridge.result(origin, pending['requestId'], pending['requestSecret'])['token']

    def test_only_named_public_origins_and_correct_pair_secrets_are_accepted(self):
        for origin in ('null', 'http://shorts-studio-75p.pages.dev', SITE + '.evil.test', 'https://other.pages.dev'):
            with self.subTest(origin=origin), self.assertRaises(BridgeError):
                self.bridge.begin(origin)
        pending = self.bridge.begin(SITE)
        for origin, secret in ((LAB, pending['requestSecret']), (SITE, 'x' * 43)):
            with self.assertRaises(BridgeError) as error:
                self.bridge.result(origin, pending['requestId'], secret)
            self.assertEqual(error.exception.code, 'PAIR_DENIED')
        self.assertEqual(self.bridge.result(SITE, pending['requestId'], pending['requestSecret']), {'state': 'pending'})

    def test_csrf_is_required_and_pending_approval_expires_at_the_exact_deadline(self):
        pending = self.bridge.begin(SITE)
        with self.assertRaises(BridgeError) as error:
            self.bridge.approve(pending['requestId'], 'wrong')
        self.assertEqual(error.exception.code, 'PAIR_CSRF')
        self.now += PAIR_TTL
        with self.assertRaises(BridgeError) as error:
            self.bridge.page(pending['requestId'])
        self.assertEqual(error.exception.status, 410)
        with self.assertRaises(BridgeError):
            self.bridge.result(SITE, pending['requestId'], pending['requestSecret'])

    def test_pairing_persists_only_hashes_and_is_scoped_to_its_origin(self):
        pending, token = self.approve()
        content = (self.local / 'browser-connections.json').read_text(encoding='utf-8')
        self.assertNotIn(token, content)
        self.assertNotIn(pending['requestSecret'], content)
        self.assertIn(hashlib.sha256(token.encode()).hexdigest(), content)
        restored = PcBridgeService(self.local)
        self.assertTrue(restored.authorized(SITE, 'Bearer ' + token))
        for origin, authorization in ((LAB, 'Bearer ' + token), (SITE, token), (SITE, 'Bearer ' + 'x' * 43), ('null', 'Bearer ' + token)):
            self.assertFalse(restored.authorized(origin, authorization))
        with self.assertRaises(BridgeError):
            restored.result(SITE, pending['requestId'], pending['requestSecret'])

    def test_revocation_removes_only_the_selected_connection(self):
        _, first = self.approve(SITE)
        _, second = self.approve(SITE)
        _, third = self.approve(LAB)
        self.bridge.revoke(SITE, 'Bearer ' + first)
        self.assertFalse(self.bridge.authorized(SITE, 'Bearer ' + first))
        self.assertTrue(self.bridge.authorized(SITE, 'Bearer ' + second))
        self.assertTrue(self.bridge.authorized(LAB, 'Bearer ' + third))

    def test_pending_limit_and_old_connection_eviction_do_not_create_unbounded_authority(self):
        for _ in range(4):
            self.bridge.begin(SITE)
        with self.assertRaises(BridgeError) as error:
            self.bridge.begin(SITE)
        self.assertEqual(error.exception.status, 429)
        tokens = []
        for _ in range(MAX_PAIRINGS + 1):
            self.now += PAIR_TTL + 1
            tokens.append(self.approve()[1])
        self.assertFalse(self.bridge.authorized(SITE, 'Bearer ' + tokens[0]))
        self.assertTrue(self.bridge.authorized(SITE, 'Bearer ' + tokens[-1]))
        self.assertEqual(len(json.loads((self.local / 'browser-connections.json').read_text())['connections']), MAX_PAIRINGS)

    def test_management_proof_is_separate_from_browser_tokens_and_bound_to_each_nonce(self):
        key = self.bridge.management_key(create=True)
        nonce = 'a' * 32
        result = self.bridge.health(nonce)
        expected = hmac.new(key.encode('ascii'), ('studio-pc-bridge-v1:' + nonce).encode('ascii'), hashlib.sha256).hexdigest()
        self.assertEqual(result['proof'], expected)
        self.assertNotEqual(result['proof'], self.bridge.health('b' * 32)['proof'])
        self.assertTrue(self.bridge.management_allowed(key))
        _, token = self.approve()
        self.assertFalse(self.bridge.management_allowed(token))
        self.assertFalse(self.bridge.authorized(SITE, 'Bearer ' + key))
        for invalid in (None, '../secret', 'a' * 31):
            with self.assertRaises(BridgeError):
                self.bridge.health(invalid)


class BridgeHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bootstrap = tempfile.TemporaryDirectory(prefix='studio-bridge-bootstrap-')
        spec = importlib.util.spec_from_file_location('studio_bridge_test_server', Path(__file__).resolve().parents[1] / 'studio_server.py')
        cls.studio = importlib.util.module_from_spec(spec)
        # 서버 모듈 초기화조차 실제 설치 등록이나 참고 녹음 폴더를 읽지 않습니다.
        with patch('pc_installation.local_data_dir', return_value=Path(cls.bootstrap.name)), \
                patch('pc_voice_config.service_identity', return_value=('gpt-sovits', None)):
            spec.loader.exec_module(cls.studio)

        class QuietHandler(cls.studio.StudioHandler):
            def log_message(self, *args):
                pass

        cls.server = cls.studio.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)
        cls.bootstrap.cleanup()

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='studio-bridge-http-')
        self.addCleanup(temporary.cleanup)
        self.bridge = PcBridgeService(Path(temporary.name))
        self.server.pc_bridge = self.bridge
        self.voice = Mock()
        self.voice.lock = threading.Lock()
        self.voice.closed = self.voice.uncertain = False
        self.voice.engine_headers = {}
        self.voice.reserve_asr.return_value = None
        self.voice.status.return_value = {'provider': 'voxcpm2', 'modelName': 'VoxCPM2-2B', 'state': 'ready',
                                         'configured': True, 'profiles': [{'id': 'synthetic-reference'}], 'privatePath': 'fake/private'}
        self.server.pc_voice = self.voice
        self.runtime = pc_runtime.PcVoiceRuntime(self.bridge.local, self.voice)
        self.runtime.status = self.voice.status
        self.server.pc_runtime = self.runtime
        self.addCleanup(self.runtime.close)
        self.asr = Mock()
        self.asr.active = False
        self.asr.lock = threading.Lock()
        self.asr.closed = self.asr.uncertain = False
        self.asr.status.return_value = {'provider': 'faster-whisper', 'configured': False, 'available': False}
        self.server.pc_asr = self.asr
        self.tracking = Mock()
        self.tracking.active = False
        self.tracking.lock = threading.Lock()
        self.tracking.closed = self.tracking.uncertain = False
        self.tracking.status.return_value = {'provider': 'sam2', 'configured': False, 'available': False}
        self.tracking.start.return_value = 'd' * 32
        self.tracking.cancel.return_value = True
        self.server.pc_tracking = self.tracking

    def request(self, path, body=None, method=None, origin=SITE, headers=None):
        payload = body if body is None or isinstance(body, bytes) else json.dumps(body).encode('utf-8')
        selected = {'X-Studio-PC-Bridge': '1', 'Content-Type': 'application/json'}
        if origin is not None:
            selected['Origin'] = origin
        selected.update(headers or {})
        selected = {name: value for name, value in selected.items() if value is not None}
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        try:
            connection.request(method or ('GET' if body is None else 'POST'), path, body=payload, headers=selected)
            response = connection.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            connection.close()

    def approved(self, origin=SITE):
        pending = self.bridge.begin(origin)
        self.bridge.approve(pending['requestId'], csrf_from(self.bridge.page(pending['requestId'])))
        return self.bridge.result(origin, pending['requestId'], pending['requestSecret'])['token']

    def test_preflight_allows_only_fixed_origins_paths_methods_and_non_management_headers(self):
        headers = {'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization, Content-Type, X-Studio-PC-Tracking, X-Studio-Consent'}
        for origin in PUBLIC_ORIGINS:
            status, _, returned = self.request('/api/pc-tracking/track', method='OPTIONS', origin=origin, headers=headers)
            self.assertEqual(status, 204)
            self.assertEqual(returned['Access-Control-Allow-Origin'], origin)
            self.assertEqual(returned['Access-Control-Allow-Private-Network'], 'true')
            self.assertNotIn('Access-Control-Allow-Credentials', returned)
        for path, origin, extra in (
            ('/api/pc-bridge/status', 'https://evil.test', {}),
            ('/api/pc-bridge/status', 'null', {}),
            ('/studio.html', SITE, {}),
            ('/api/pc-bridge/shutdown', SITE, {'Access-Control-Request-Headers': 'X-Studio-Bridge-Key'}),
            ('/api/pc-bridge/status', SITE, {'Access-Control-Request-Method': 'DELETE'}),
            ('/api/pc-bridge/status', SITE, {'Host': 'evil.test'}),
        ):
            with self.subTest(path=path, origin=origin, extra=extra):
                self.assertEqual(self.request(path, method='OPTIONS', origin=origin, headers={**headers, **extra})[0], 403)

    def test_pairing_approval_needs_local_form_origin_and_csrf(self):
        status, data, _ = self.request('/api/pc-bridge/pair/start', {})
        self.assertEqual(status, 201)
        pending = json.loads(data)
        status, page, headers = self.request(pending['approvalPath'], origin=None)
        self.assertEqual(status, 200)
        self.assertEqual(headers['X-Frame-Options'], 'DENY')
        self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        form = urlencode({'requestId': pending['requestId'], 'csrf': csrf_from(page)}).encode('ascii')
        form_headers = {'Content-Type': 'application/x-www-form-urlencoded', 'X-Studio-PC-Bridge': None}
        for origin, extra in ((SITE, {}), (None, {}), (self.base, {'Sec-Fetch-Site': 'cross-site'})):
            self.assertEqual(self.request('/api/pc-bridge/approve', form, origin=origin, headers={**form_headers, **extra})[0], 403)
        self.assertEqual(self.request('/api/pc-bridge/approve', form, origin=self.base, headers=form_headers)[0], 200)
        status, result, _ = self.request('/api/pc-bridge/pair/result', {'requestId': pending['requestId'], 'requestSecret': pending['requestSecret']})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(result)['state'], 'approved')

    def test_public_status_requires_origin_bound_bearer_and_hides_private_reference_fields(self):
        token = self.approved()
        valid = {'Authorization': 'Bearer ' + token}
        for origin, extra in ((LAB, valid), (SITE, {}), (SITE, {**valid, 'X-Studio-PC-Bridge': None}),
                              (SITE, {**valid, 'Host': 'evil.test'})):
            self.assertEqual(self.request('/api/pc-bridge/status', origin=origin, headers=extra)[0], 403)
        self.voice.status.assert_not_called()
        status, data, headers = self.request('/api/pc-bridge/status', headers=valid)
        self.assertEqual(status, 200)
        self.assertEqual(headers['Access-Control-Allow-Origin'], SITE)
        voice = json.loads(data)['engines']['voice']
        self.assertEqual(voice['provider'], 'voxcpm2')
        for private in ('profiles', 'privatePath', token):
            self.assertNotIn(private, data.decode('utf-8'))

    def test_health_is_native_only_and_proves_the_fresh_nonce(self):
        key = self.bridge.management_key(create=True)
        nonce = 'e' * 32
        headers = {'X-Studio-Bridge-Nonce': nonce}
        for origin, extra in ((SITE, {}), (self.base, {}), (None, {'Sec-Fetch-Site': 'none'}),
                              (None, {'Host': 'evil.test'})):
            self.assertEqual(self.request('/api/pc-bridge/health', origin=origin, headers={**headers, **extra})[0], 403)
        status, data, returned = self.request('/api/pc-bridge/health', origin=None, headers=headers)
        self.assertEqual(status, 200)
        self.assertNotIn('Access-Control-Allow-Origin', returned)
        result = json.loads(data)
        self.assertEqual(result['nonce'], nonce)
        expected = hmac.new(key.encode('ascii'), ('studio-pc-bridge-v1:' + nonce).encode('ascii'), hashlib.sha256).hexdigest()
        self.assertEqual(result['proof'], expected)
        self.assertNotIn(key, data.decode('utf-8'))

    def test_shutdown_requires_native_management_key_and_does_not_interrupt_busy_jobs(self):
        key = self.bridge.management_key(create=True)
        token = self.approved()
        headers = {'X-Studio-Bridge-Key': key}
        called = threading.Event()
        # HTTP 서버의 실제 종료 대신 호출 여부만 확인합니다.
        with patch.object(self.server, 'shutdown', side_effect=called.set):
            for origin, extra in ((SITE, {}), (self.base, {}), (None, {'Sec-Fetch-Site': 'none'}),
                                  (None, {'X-Studio-Bridge-Key': None, 'Authorization': 'Bearer ' + token}),
                                  (None, {'X-Studio-Bridge-Key': token})):
                self.assertEqual(self.request('/api/pc-bridge/shutdown', {}, origin=origin, headers={**headers, **extra})[0], 403)
            self.assertEqual(self.request('/api/pc-bridge/shutdown', {'path': 'unused'}, origin=None, headers=headers)[0], 400)
            self.asr.active = True
            self.assertEqual(self.request('/api/pc-bridge/shutdown', {}, origin=None, headers=headers)[0], 409)
            self.asr.active = False
            self.assertFalse(called.is_set())
            status, data, _ = self.request('/api/pc-bridge/shutdown', {}, origin=None, headers=headers)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(data), {'stopping': True})
            self.assertTrue(called.wait(1))

    def test_shutdown_returns_conflict_for_another_server_engine_job_without_closing_services(self):
        key = self.bridge.management_key(create=True)
        engine = EngineASRReservation('voxcpm2')
        engine.begin_tts()
        self.voice.reserve_asr.side_effect = lambda **data: engine.reserve({
            'requiredFreeMiB': data['required_free_mib'], 'ttlSeconds': data['ttl']})
        with patch.object(self.server, 'shutdown') as shutdown:
            status, _, _ = self.request('/api/pc-bridge/shutdown', {}, origin=None,
                                        headers={'X-Studio-Bridge-Key': key})
        self.assertEqual(status, 409)
        shutdown.assert_not_called()
        self.assertTrue(engine.tts_active)
        self.assertFalse(self.runtime.stopping or self.voice.closed)
        self.assertFalse(self.asr.closed or self.tracking.closed)
        self.assertFalse(self.voice.lock.locked())

    def test_shutdown_barrier_rejects_late_pc_requests_before_their_bodies_are_processed(self):
        key = self.bridge.management_key(create=True)
        token = self.approved()
        with patch.object(self.server, 'shutdown'):
            self.assertEqual(self.request('/api/pc-bridge/shutdown', {}, origin=None,
                                          headers={'X-Studio-Bridge-Key': key})[0], 200)
            for path, header in (('/api/pc-tracking/track', 'X-Studio-PC-Tracking'),
                                  ('/api/voice-clone/synthesize', 'X-Studio-PC-Voice'),
                                  ('/api/pc-asr/transcribe', 'X-Studio-PC-ASR')):
                with self.subTest(path=path):
                    status, body, _ = self.request(path, b'not parsed', headers={
                        'Authorization': 'Bearer ' + token, header: '1'})
                    self.assertEqual(status, 503)
                    self.assertEqual(json.loads(body)['error']['code'], 'PC_STOPPING')
            self.assertEqual(self.request('/api/pc-bridge/pair/start', {})[0], 503)
        self.tracking.start.assert_not_called()
        self.asr.start.assert_not_called()
        self.voice.synthesize.assert_not_called()

    def test_approved_shutdown_still_runs_if_the_management_client_disconnects(self):
        key = self.bridge.management_key(create=True)
        called = threading.Event()
        original = self.server.RequestHandlerClass.json_response
        def disconnected_reply(handler, status, data):
            if data == {'stopping': True}:
                raise BrokenPipeError('synthetic disconnected management client')
            return original(handler, status, data)
        with patch.object(self.server, 'shutdown', side_effect=called.set), \
                patch.object(self.server.RequestHandlerClass, 'json_response', disconnected_reply):
            with self.assertRaises(http.client.RemoteDisconnected):
                self.request('/api/pc-bridge/shutdown', {}, origin=None,
                             headers={'X-Studio-Bridge-Key': key})
            self.assertTrue(called.wait(1))
        self.assertTrue(self.runtime.stopping and self.voice.closed)

    def test_tracking_upload_needs_pairing_and_consent_and_rejects_oversized_or_wrong_bodies(self):
        token = self.approved()
        options = {'start': 10, 'duration': 2, 'seedTime': .5, 'box': {'x': .2, 'y': .2, 'w': .3, 'h': .4}}
        headers = {'Authorization': 'Bearer ' + token, 'X-Studio-PC-Tracking': '1',
                   'X-Studio-Consent': 'video-to-local-tracking', 'X-Studio-Tracking-Options': json.dumps(options),
                   'Content-Type': 'video/mp4'}
        for origin, extra in ((LAB, {}), (None, {}), (SITE, {'Authorization': None}),
                              (SITE, {'X-Studio-PC-Tracking': None}), (SITE, {'X-Studio-Consent': None})):
            self.assertEqual(self.request('/api/pc-tracking/track', b'fake video', origin=origin, headers={**headers, **extra})[0], 403)
        for extra, expected in (({'Content-Length': str(256 * 1024 * 1024 + 1)}, 413),
                                ({'Transfer-Encoding': 'chunked'}, 413), ({'Content-Type': 'text/plain'}, 415),
                                ({'X-Studio-Tracking-Options': 'invalid'}, 400)):
            self.assertEqual(self.request('/api/pc-tracking/track', b'fake video', headers={**headers, **extra})[0], expected)
        self.tracking.start.assert_not_called()
        status, data, _ = self.request('/api/pc-tracking/track', b'fake video', headers=headers)
        self.assertEqual(status, 202)
        self.assertEqual(json.loads(data)['jobId'], 'd' * 32)
        self.tracking.start.assert_called_once_with(b'fake video', options)


class InstallationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='studio-installation-unit-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / 'registration'
        self.app = self.root / 'moved-app'
        self.app.mkdir()
        environment = patch.dict(os.environ, {'STUDIO_LOCAL_DIR': ''})
        environment.start()
        self.addCleanup(environment.stop)

    def test_registration_survives_app_move_without_copying_private_files(self):
        local = self.root / 'private-data'
        local.mkdir()
        original = b'synthetic-reference-only'
        (local / 'reference.wav').write_bytes(original)
        pc_installation.register_installation(local, app=self.app, python=sys.executable, home=self.home)
        encoded = (self.home / 'installation.json').read_text(encoding='utf-8')
        self.assertEqual(set(json.loads(encoded)), {'version', 'localDir', 'appDir', 'python'})
        self.assertNotIn('reference.wav', encoded)
        self.assertEqual(pc_installation.local_data_dir(root=self.app, home=self.home), local.resolve())
        self.assertEqual(pc_installation.local_data_dir(root=self.root / 'another-app', home=self.home), local.resolve())
        self.assertEqual((local / 'reference.wav').read_bytes(), original)
        self.assertEqual([path.name for path in self.home.iterdir()], ['installation.json'])

    def test_explicit_local_override_wins_and_rejects_relative_or_network_paths(self):
        registered = self.root / 'registered'
        pc_installation.register_installation(registered, home=self.home)
        override = self.root / 'explicit'
        with patch.dict(os.environ, {'STUDIO_LOCAL_DIR': str(override)}):
            self.assertEqual(pc_installation.local_data_dir(root=self.app, home=self.home), override.resolve())
        for value in ('relative/path', '//external/share', r'\\external\share'):
            with self.subTest(value=value), patch.dict(os.environ, {'STUDIO_LOCAL_DIR': value}), self.assertRaises(ValueError):
                pc_installation.local_data_dir(root=self.app, home=self.home)

    def test_invalid_registration_falls_back_only_to_the_known_local_directory(self):
        self.home.mkdir()
        (self.home / 'installation.json').write_text('{"version":1,"localDir":"relative/path"}', encoding='utf-8')
        self.assertEqual(pc_installation.local_data_dir(root=self.app, home=self.home), self.home / 'data')
        existing = self.app / '.studio-local'
        existing.mkdir()
        (existing / 'pc-asr.json').write_text('{}', encoding='utf-8')
        self.assertEqual(pc_installation.local_data_dir(root=self.app, home=self.home), existing.resolve())


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='studio-runtime-unit-')
        self.addCleanup(temporary.cleanup)
        self.local = Path(temporary.name)
        self.config = {'provider': 'voxcpm2', 'engineKey': 'e' * 43, 'python': sys.executable}
        self.service = SimpleNamespace(lock=threading.Lock(), uncertain=False, closed=False, opener=Mock(),
                                       endpoint='http://127.0.0.1:9880', provider='gpt-sovits', engine_headers={})
        self.service.reserve_asr = Mock(return_value=None)
        self.service.release_asr = Mock(return_value={'released': True})
        self.asr = SimpleNamespace(lock=threading.Lock(), active=None, closed=False, uncertain=False)
        self.tracking = SimpleNamespace(lock=threading.Lock(), active=None, closed=False, uncertain=False)
        self.runtime = pc_runtime.PcVoiceRuntime(self.local, self.service)
        self.process = Mock()
        self.process.poll.return_value = None
        self.job = Mock()
        self.job.name = 'synthetic-owned-job'
        self.mocks = {}
        for name, value in (('settings_path', self.local / 'pc-voice.json'), ('read_settings', self.config),
                            ('verified_engine', False), ('WindowsJob', self.job), ('stop_process', None)):
            replacing = patch.object(pc_runtime, name, return_value=value)
            self.mocks[name] = replacing.start()
            self.addCleanup(replacing.stop)
        launch = patch.object(pc_runtime.subprocess, 'Popen', return_value=self.process)
        self.launch = launch.start()
        self.addCleanup(launch.stop)
        socket = patch.object(pc_runtime.socket, 'socket')
        self.socket = socket.start()
        self.addCleanup(socket.stop)
        self.addCleanup(self.runtime.close)

    def test_verified_existing_engine_is_never_owned_or_stopped(self):
        self.mocks['verified_engine'].return_value = True
        self.assertTrue(self.runtime.ensure_running())
        self.assertEqual(self.service.provider, 'voxcpm2')
        self.mocks['verified_engine'].assert_called_once_with(self.service.opener, self.service.endpoint,
                                                            self.config['engineKey'], timeout=1, provider='voxcpm2')
        self.launch.assert_not_called()
        self.runtime.close()
        self.mocks['stop_process'].assert_not_called()
        self.job.close.assert_not_called()

    def test_foreign_port_occupant_is_not_replaced_or_terminated(self):
        self.socket.return_value.__enter__.return_value.bind.side_effect = OSError('occupied')
        self.assertTrue(self.runtime.ensure_running())
        self.assertIn('다른 엔진', self.runtime.message)
        self.launch.assert_not_called()
        self.runtime.close()
        self.mocks['stop_process'].assert_not_called()

    def test_owned_process_uses_private_stdio_and_only_its_own_cleanup(self):
        names = ('OPENAI_API_KEY', 'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'ANTHROPIC_API_KEY')
        with patch.dict(os.environ, {name: 'synthetic-secret' for name in names}):
            self.assertTrue(self.runtime.ensure_running())
        args, options = self.launch.call_args
        self.assertEqual(args[0], [sys.executable, str(pc_runtime.ROOT / 'pc_voice_engine.py'), '--settings',
                                  str(self.local / 'pc-voice.json'), '--port', '9880', '--job-name', self.job.name])
        for name in names:
            self.assertNotIn(name, options['env'])
        for stream in ('stdin', 'stdout', 'stderr'):
            self.assertEqual(options[stream], pc_runtime.subprocess.DEVNULL)
        self.assertEqual(options['creationflags'], getattr(pc_runtime.subprocess, 'CREATE_NO_WINDOW', 0))
        self.assertTrue(self.runtime.ensure_running())
        self.launch.assert_called_once()
        self.runtime.close()
        self.runtime.close()
        self.job.close.assert_called_once()
        self.mocks['stop_process'].assert_called_once_with(self.process)

    def test_busy_or_uncertain_voice_service_never_starts_a_second_engine(self):
        self.service.lock.acquire()
        try:
            self.assertTrue(self.runtime.ensure_running())
        finally:
            self.service.lock.release()
        self.service.uncertain = True
        self.assertTrue(self.runtime.ensure_running())
        self.mocks['verified_engine'].assert_not_called()
        self.launch.assert_not_called()

    def test_shutdown_refuses_other_server_tts_or_gpu_lease_without_changing_state(self):
        for kind in ('tts', 'gpu-lease'):
            engine = EngineASRReservation('voxcpm2')
            token = None
            if kind == 'tts':
                engine.begin_tts()
            else:
                token = engine.reserve({'requiredFreeMiB': 3200, 'ttlSeconds': 120})['token']
            self.service.reserve_asr.side_effect = lambda **data: engine.reserve({
                'requiredFreeMiB': data['required_free_mib'], 'ttlSeconds': data['ttl']})
            with self.subTest(kind=kind), self.assertRaises(VoiceError) as caught:
                self.runtime.prepare_shutdown(self.asr, self.tracking)
            self.assertEqual(caught.exception.status, 409)
            self.assertEqual(engine.token, token)
            self.assertEqual(engine.tts_active, kind == 'tts')
            self.assertFalse(self.runtime.stopping)
            self.assertFalse(self.service.closed or self.service.uncertain)
            self.assertFalse(self.asr.closed or self.tracking.closed)
            self.assertFalse(self.service.lock.locked())
            self.job.close.assert_not_called()
            self.mocks['stop_process'].assert_not_called()

    def test_shutdown_keeps_local_gate_until_owned_process_tree_is_confirmed_stopped(self):
        self.runtime.ensure_running()
        self.service.reserve_asr.return_value = {'token': 'a' * 64}
        self.runtime.prepare_shutdown(self.asr, self.tracking)
        self.assertTrue(self.service.lock.locked())
        self.assertTrue(self.service.closed and self.asr.closed and self.tracking.closed)
        self.assertFalse(self.runtime.ensure_running())
        self.launch.assert_called_once()
        events = []
        def close_job():
            self.assertTrue(self.service.lock.locked())
            events.append('job')
        self.job.close.side_effect = close_job
        self.mocks['stop_process'].side_effect = lambda process: events.append('redirector')
        self.mocks['verified_engine'].return_value = None
        self.runtime.close()
        self.assertEqual(events, ['job', 'redirector'])
        self.service.release_asr.assert_not_called()
        self.assertFalse(self.service.lock.locked())
        self.assertTrue(self.runtime.closed)

    def test_shutdown_releases_only_its_lease_when_voice_engine_is_reused(self):
        self.mocks['verified_engine'].return_value = True
        self.runtime.ensure_running()
        self.service.reserve_asr.return_value = {'token': 'b' * 64}
        self.runtime.prepare_shutdown(self.asr, self.tracking)
        self.runtime.close()
        self.service.release_asr.assert_called_once_with('b' * 64)
        self.job.close.assert_not_called()
        self.mocks['stop_process'].assert_not_called()
        self.assertFalse(self.service.lock.locked())

    def test_cleanup_failure_still_stops_redirector_and_never_releases_gpu_reservation(self):
        self.runtime.ensure_running()
        self.service.reserve_asr.return_value = {'token': 'c' * 64}
        self.runtime.prepare_shutdown(self.asr, self.tracking)
        self.job.close.side_effect = OSError('synthetic cleanup failure')
        try:
            with self.assertRaises(OSError):
                self.runtime.close()
            self.mocks['stop_process'].assert_called_once_with(self.process)
            self.service.release_asr.assert_not_called()
            self.assertTrue(self.service.uncertain and self.service.closed)
            self.assertTrue(self.service.lock.locked())
            self.assertFalse(self.runtime.ensure_running())
            self.launch.assert_called_once()
        finally:
            self.job.close.side_effect = None
            self.mocks['verified_engine'].return_value = None

    def test_failed_start_cleanup_is_not_treated_as_a_retryable_offline_engine(self):
        self.runtime.ensure_running()
        self.process.poll.return_value = 1
        self.job.close.side_effect = OSError('synthetic cleanup failure')
        try:
            self.assertTrue(self.runtime.ensure_running())
            self.assertTrue(self.service.uncertain)
            self.mocks['stop_process'].assert_called_once_with(self.process)
            self.assertTrue(self.runtime.ensure_running())
            self.launch.assert_called_once()
        finally:
            self.job.close.side_effect = None

    def test_uncertain_reservation_release_keeps_shutdown_gate_closed(self):
        self.mocks['verified_engine'].return_value = True
        self.runtime.ensure_running()
        self.service.reserve_asr.return_value = {'token': 'd' * 64}
        self.runtime.prepare_shutdown(self.asr, self.tracking)
        self.service.release_asr.side_effect = VoiceError('ENGINE_RESTART_REQUIRED', 'synthetic failure', 503)
        try:
            with self.assertRaises(OSError):
                self.runtime.close()
            self.assertTrue(self.service.uncertain and self.service.closed)
            self.assertTrue(self.service.lock.locked())
            self.assertFalse(self.runtime.ensure_running())
        finally:
            self.service.release_asr.side_effect = None

    def test_status_waiting_for_close_cannot_respawn_the_owned_engine(self):
        self.runtime.ensure_running()
        entered, finish = threading.Event(), threading.Event()
        def close_job():
            entered.set()
            if not finish.wait(3):
                raise AssertionError('Synthetic close was not released')
        self.job.close.side_effect = close_job
        closing = threading.Thread(target=self.runtime.close)
        result = []
        checking = threading.Thread(target=lambda: result.append(self.runtime.ensure_running()))
        closing.start()
        try:
            self.assertTrue(entered.wait(1))
            checking.start()
        finally:
            finish.set()
            closing.join(timeout=3)
            if checking.ident is not None:
                checking.join(timeout=3)
        self.assertFalse(closing.is_alive() or checking.is_alive())
        self.assertEqual(result, [False])
        self.launch.assert_called_once()

    def test_cold_server_can_shutdown_only_without_owned_process_and_with_connection_refused(self):
        self.service.engine_headers = {'X-Studio-Engine-Key': 'e' * 43}
        self.mocks['verified_engine'].return_value = None
        self.runtime.prepare_shutdown(self.asr, self.tracking)
        self.assertTrue(self.runtime.stopping and self.service.closed)
        self.service.reserve_asr.assert_not_called()
        self.runtime.close()
        self.mocks['stop_process'].assert_not_called()
        self.job.close.assert_not_called()

    def test_unknown_shared_engine_identity_does_not_use_the_cold_shutdown_exception(self):
        self.service.engine_headers = {'X-Studio-Engine-Key': 'e' * 43}
        self.mocks['verified_engine'].return_value = False
        with self.assertRaises(VoiceError) as caught:
            self.runtime.prepare_shutdown(self.asr, self.tracking)
        self.assertEqual(caught.exception.code, 'ENGINE_NOT_READY')
        self.assertFalse(self.runtime.stopping or self.service.closed)
        self.assertFalse(self.service.lock.locked())
        self.service.reserve_asr.assert_not_called()

    def test_owned_starting_engine_cannot_shutdown_without_its_global_reservation(self):
        self.runtime.ensure_running()
        self.mocks['verified_engine'].return_value = None
        self.service.reserve_asr.side_effect = VoiceError('ENGINE_NOT_READY', 'synthetic starting engine', 503)
        with self.assertRaises(VoiceError) as caught:
            self.runtime.prepare_shutdown(self.asr, self.tracking)
        self.assertEqual(caught.exception.status, 503)
        self.assertFalse(self.runtime.stopping or self.service.closed)
        self.assertFalse(self.service.lock.locked())
        self.job.close.assert_not_called()
        self.mocks['stop_process'].assert_not_called()

    def delayed_refusal(self):
        # 실측처럼 1초에는 시간 초과, 더 긴 확인에서는 연결 거절이 되는 소켓을 모사한다.
        def open_request(request, timeout):
            if timeout <= 2:
                raise TimeoutError('synthetic short connect deadline')
            raise URLError(ConnectionRefusedError(10061, 'synthetic closed loopback port'))
        self.service.opener.open.side_effect = open_request
        self.mocks['verified_engine'].side_effect = verified_engine

    def test_cold_shutdown_waits_long_enough_to_distinguish_refusal_from_short_timeout(self):
        self.service.engine_headers = {'X-Studio-Engine-Key': 'e' * 43}
        self.delayed_refusal()
        self.runtime.prepare_shutdown(self.asr, self.tracking)
        self.assertTrue(self.runtime.stopping)
        self.assertEqual(self.service.opener.open.call_args.kwargs['timeout'], 4)
        self.service.reserve_asr.assert_not_called()

    def test_owned_engine_cleanup_uses_the_same_longer_refusal_probe(self):
        self.runtime.ensure_running()
        self.service.reserve_asr.return_value = {'token': 'e' * 64}
        self.runtime.prepare_shutdown(self.asr, self.tracking)
        self.delayed_refusal()
        self.service.release_asr.side_effect = AssertionError('A stopped engine cannot release a lease over HTTP')
        self.runtime.close()
        self.assertEqual(self.service.opener.open.call_args.kwargs['timeout'], 4)
        self.service.release_asr.assert_not_called()
        self.assertFalse(self.service.uncertain)
        self.assertFalse(self.service.lock.locked())

    def test_real_timeout_during_cold_shutdown_is_still_rejected(self):
        self.service.engine_headers = {'X-Studio-Engine-Key': 'e' * 43}
        self.service.opener.open.side_effect = TimeoutError('synthetic unreachable endpoint')
        self.mocks['verified_engine'].side_effect = verified_engine
        with self.assertRaises(VoiceError) as caught:
            self.runtime.prepare_shutdown(self.asr, self.tracking)
        self.assertEqual(caught.exception.code, 'ENGINE_NOT_READY')
        self.assertFalse(self.runtime.stopping or self.service.closed)
        self.assertFalse(self.service.lock.locked())


class VoiceGateTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='studio-voice-gate-')
        self.addCleanup(temporary.cleanup)
        self.voice = VoiceCloneService(Path(temporary.name) / 'unused-voices', provider='voxcpm2')

    def test_asr_only_install_does_not_require_or_contact_a_voice_engine(self):
        with patch('pc_voice.verified_engine') as verify:
            self.assertIsNone(self.voice.reserve_asr(required_free_mib=3200, ttl=120))
        verify.assert_not_called()

    def test_configured_but_offline_engine_never_grants_an_unreserved_gpu_job(self):
        self.voice.engine_headers = {'X-Studio-Engine-Key': 'x' * 43}
        for state in (None, False):
            with self.subTest(state=state), patch('pc_voice.verified_engine', return_value=state), \
                    patch.object(self.voice, '_asr_request') as request:
                with self.assertRaises(VoiceError) as caught:
                    self.voice.reserve_asr(required_free_mib=3200, ttl=120)
                self.assertEqual(caught.exception.code, 'ENGINE_NOT_READY')
                self.assertEqual(caught.exception.status, 503)
                request.assert_not_called()
                self.assertFalse(self.voice.uncertain)

    def test_closed_or_uncertain_service_rejects_work_even_after_local_lock_is_free(self):
        for closed, uncertain, code in ((True, False, 'PC_STOPPING'),
                                         (False, True, 'ENGINE_RESTART_REQUIRED')):
            self.voice.closed, self.voice.uncertain = closed, uncertain
            with self.subTest(code=code), patch('pc_voice.verified_engine') as verify:
                with self.assertRaises(VoiceError) as caught:
                    with self.voice.exclusive():
                        self.fail('Closed service accepted a new task')
                self.assertEqual(caught.exception.code, code)
                with self.assertRaises(VoiceError):
                    self.voice.reserve_asr(required_free_mib=3200, ttl=120)
                with patch.object(self.voice, 'profiles', return_value=[]):
                    self.assertIn(self.voice.status()['state'], ('stopping', 'restart-required'))
                verify.assert_not_called()
            self.assertFalse(self.voice.lock.locked())
