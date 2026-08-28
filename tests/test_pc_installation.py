"""사용자 설정·미디어·네트워크·레지스트리에 접근하지 않고 설치 경계를 확인합니다."""
import hashlib
import ast
import hmac
import io
import gzip
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, MagicMock, patch
from urllib.error import HTTPError
import zipfile

import build_pc_support_package as package
import install_pc_support as installer
import pc_installation


class InstallationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='studio-install-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source, self.home, self.local = (self.root / name for name in ('source', 'home', 'data'))
        self.source.mkdir(); self.local.mkdir()
        environment = {key: os.environ[key] for key in ('SystemRoot', 'WINDIR', 'PATH', 'COMSPEC', 'PATHEXT',
                       'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'TEMP', 'TMP') if key in os.environ}
        environment.update({'STUDIO_LOCAL_DIR': str(self.local), 'LOCALAPPDATA': str(self.root / 'Local'),
                            'APPDATA': str(self.root / 'Roaming')})
        self.env = patch.dict(os.environ, environment, clear=True)
        self.env.start(); self.addCleanup(self.env.stop)
        for name in package.PC_FILES:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(('# synthetic public fixture: ' + name + '\n').encode())

    def configured(self, name, *, local=None):
        local = local or self.local
        spec = installer.COMPONENTS[name]
        engine = local / spec['directory']; model = engine / 'model'
        model.mkdir(parents=True, exist_ok=True)
        python = engine / 'python.exe'; python.write_bytes(b'synthetic executable placeholder')
        data = {'provider': spec['provider'], 'python': str(python), 'engine': str(engine), 'model': str(model)}
        if name == 'voice':
            data['engineKey'] = 'a' * 64
        (local / spec['configs'][0]).write_text(json.dumps(data), encoding='utf-8')
        return data

    def bridge_key(self):
        key = 'b' * 64
        (self.local / 'pc-bridge-key.json').write_text(json.dumps({'key': key}), encoding='utf-8')
        return key

    def health(self, key, nonce):
        proof = hmac.new(key.encode(), ('studio-pc-bridge-v1:' + nonce).encode(), hashlib.sha256).hexdigest()
        return {'provider': 'shorts-studio-pc-bridge', 'version': 1, 'nonce': nonce, 'proof': proof}

    def fake_http(self, key):
        def respond(path, *, headers=None, data=None, timeout=2):
            if path.endswith('/health'):
                self.assertEqual(timeout, 2)
                self.assertEqual(set(headers), {'X-Studio-Bridge-Nonce'})
                self.assertRegex(headers['X-Studio-Bridge-Nonce'], r'^[a-f0-9]{32}$')
                return self.health(key, headers['X-Studio-Bridge-Nonce'])
            self.assertEqual(path, '/api/pc-bridge/shutdown')
            self.assertEqual(timeout, 20)
            self.assertEqual(headers, {'Content-Type': 'application/json', 'X-Studio-Bridge-Key': key})
            self.assertEqual(data, b'{}')
            return {'ok': True}
        return respond

    def test_package_uses_only_public_allowlist_and_is_repeatable(self):
        secret = b'fixture-only-private-key-do-not-publish-1234567890'
        for name in ('.git/private.txt', '.studio-local/voices/private.txt', '.studio-local/pc-bridge-key.json',
                     '.studio-local/pc-voice.json', 'models/secret.bin', 'private.txt'):
            path = self.source / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(secret)
        output = self.root / 'output'
        first = package.build_package(self.source, output)
        second = package.build_package(self.source, output)
        self.assertEqual(first['sha256'], second['sha256'])
        manifest = package.read_package(first['archive'], first['sha256'])
        self.assertEqual({item['path'] for item in manifest['files']}, set(package.PC_FILES))
        with zipfile.ZipFile(first['archive']) as archive:
            self.assertEqual(set(archive.namelist()), {*package.PC_FILES, package.MANIFEST})
            for name in archive.namelist():
                content = archive.read(name)
                self.assertNotIn(secret, content)
                self.assertNotIn(str(self.root).encode(), content)
                self.assertNotIn(str(self.home).encode(), content)
        command = Path(first['installer']).read_text(encoding='utf-8')
        self.assertIn(first['sha256'], command)
        self.assertIn(str(first['size']), command)
        self.assertIn(package.DOWNLOAD_ORIGIN + '/downloads/' + package.ZIP_NAME, command)
        self.assertLess(first['assetSizes']['archiveBytes'], package.CLOUDFLARE_MAX_ASSET_BYTES)
        self.assertLess(first['assetSizes']['installerBytes'], package.CLOUDFLARE_MAX_ASSET_BYTES)

    def test_public_sources_and_manifest_reject_private_paths_or_static_keys(self):
        target = self.source / 'studio_server.py'
        samples = [b'private = "C:/Users/fictional-user/AppData/Local/private"',
                   b'private = "/home/fictional-user/private"', b'{"engineKey":"' + b'a' * 64 + b'"}',
                   b'{"key":"' + b'b' * 64 + b'"}']
        for content in samples:
            with self.subTest(content=content[:16]):
                target.write_bytes(content)
                with self.assertRaises(ValueError) as error:
                    package.source_manifest(self.source)
                self.assertNotIn('fictional-user', str(error.exception))
                self.assertNotIn('a' * 64, str(error.exception))
        target.write_bytes(b'# public source')
        manifest = package.source_manifest(self.source)
        manifest['localDir'] = '/home/fictional-user/private'
        with self.assertRaises(ValueError):
            package.validate_manifest(manifest)
        manifest = package.source_manifest(self.source)
        manifest['files'][0]['key'] = 'b' * 64
        with self.assertRaises(ValueError):
            package.validate_manifest(manifest)

    def test_cloudflare_limit_uses_uploaded_file_size_not_gzip_size(self):
        large = b'x' * (package.CLOUDFLARE_MAX_ASSET_BYTES + 1)
        self.assertLess(len(gzip.compress(large, mtime=0)), package.CLOUDFLARE_MAX_ASSET_BYTES)
        with self.assertRaisesRegex(ValueError, 'Cloudflare'):
            package.check_release_assets(large, b'installer')
        with self.assertRaisesRegex(ValueError, 'Cloudflare'):
            package.check_release_assets(b'zip', large)

    def test_rejects_paths_tampering_boolean_size_and_unknown_manifest(self):
        for name in ('../studio_server.py', '/studio_server.py', 'public/../../secret', r'public\secret',
                     'CON', 'public/NUL.txt', 'public//pc-voice-setup.html', 'secret.txt', 'studio_server.py.'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                package.safe_member(name)
        manifest = package.source_manifest(self.source)
        manifest['files'][0]['size'] = True
        with self.assertRaises(ValueError):
            package.validate_manifest(manifest)
        result = package.build_package(self.source, self.root / 'output')
        with self.assertRaises(ValueError):
            package.read_package(result['archive'], '0' * 64)
        with zipfile.ZipFile(self.root / 'bad.zip', 'w') as archive:
            archive.writestr('studio_server.py', b'changed')
            archive.writestr(package.MANIFEST, json.dumps(package.source_manifest(self.source)))
        with self.assertRaises(ValueError):
            package.read_package(self.root / 'bad.zip')

    def test_zip_symlink_and_oversized_manifest_are_rejected_before_extract(self):
        path = self.root / 'link.zip'
        with zipfile.ZipFile(path, 'w') as archive:
            entry = zipfile.ZipInfo('studio_server.py'); entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(entry, b'../../outside')
        with self.assertRaises(ValueError):
            package.read_package(path)
        manifest = package.source_manifest(self.source)
        manifest['files'][0]['size'] = package.MAX_FILE_BYTES + 1
        with self.assertRaises(ValueError):
            package.validate_manifest(manifest)
        self.assertFalse((self.root / 'outside').exists())

    def test_package_covers_local_python_import_dependencies(self):
        source = Path(__file__).resolve().parents[1]
        for filename in package.PC_FILES:
            if not filename.endswith('.py'):
                continue
            tree = ast.parse((source / filename).read_text(encoding='utf-8'))
            for node in ast.walk(tree):
                names = [node.module] if isinstance(node, ast.ImportFrom) and node.module else [alias.name for alias in node.names] if isinstance(node, ast.Import) else []
                for name in names:
                    module = name.split('.')[0] + '.py'
                    if (source / module).is_file():
                        self.assertIn(module, package.PC_FILES, filename + ' imports ' + module)

    def test_application_update_preserves_data_unknown_files_and_registration(self):
        original = self.local / 'synthetic-reference.txt'; original.write_text('keep', encoding='utf-8')
        app, local = installer.install_application(self.source, home=self.home, local=self.local)
        extra = app / 'user-created.txt'; extra.write_text('preserve', encoding='utf-8')
        previous = (app / 'studio_server.py').read_bytes()

        (self.source / 'studio_server.py').write_bytes(b'# updated synthetic server\n')
        installer.install_application(self.source, home=self.home, local=self.local)
        self.assertEqual((app / 'studio_server.py').read_bytes(), b'# updated synthetic server\n')
        self.assertEqual(extra.read_text(encoding='utf-8'), 'preserve')
        self.assertEqual(original.read_text(encoding='utf-8'), 'keep')
        self.assertTrue(any(path.read_bytes() == previous for path in (self.home / 'backups').glob('*/studio_server.py')))
        registration = pc_installation.read_registration(self.home)
        self.assertEqual(Path(registration['localDir']), local)
        self.assertEqual(Path(registration['appDir']), app)

    def test_install_records_the_resolved_home_and_app_paths(self):
        alias = self.root / 'logical-home'
        original = Path.resolve
        def resolved(path, *args, **kwargs):
            if path.is_relative_to(alias):
                return original(self.home / path.relative_to(alias), *args, **kwargs)
            return original(path, *args, **kwargs)
        with patch.object(Path, 'resolve', resolved):
            app, local = installer.install_application(self.source, home=alias, local=self.local)
        self.assertEqual(app, self.home / 'app')
        self.assertFalse(alias.exists())
        registration = pc_installation.read_registration(self.home)
        self.assertEqual(Path(registration['appDir']), app)
        self.assertEqual(Path(registration['localDir']), local)

    def test_explicit_home_launch_and_check_never_use_a_different_default(self):
        pc_installation.register_installation(self.local, app=self.source, python=sys.executable, home=self.home)
        with patch.object(installer, 'installation_home') as default_home, patch.object(installer, 'local_data_dir') as default_local, patch.object(installer, 'start_bridge', return_value='started') as start, patch.object(installer, 'bridge_running', return_value=False), patch.object(installer, 'component_state', return_value='configured'), patch('sys.stdout', new=io.StringIO()):
            self.assertEqual(installer.main(['--start', '--installation-home', str(self.home)]), 0)
            self.assertEqual(installer.main(['--check', '--installation-home', str(self.home)]), 0)
        default_home.assert_not_called(); default_local.assert_not_called()
        start.assert_called_once_with(self.source, self.local, python=Path(sys.executable).resolve())
        with patch.object(installer, 'start_bridge') as start, patch.object(installer, 'stop_bridge') as stop:
            with self.assertRaisesRegex(RuntimeError, '등록 정보'):
                installer.main(['--restart', '--installation-home', str(self.root / 'missing-home')])
        start.assert_not_called(); stop.assert_not_called()

    @unittest.skipUnless(os.name == 'nt', 'Windows 실행 명령은 모의 객체만 사용합니다.')
    def test_all_launcher_commands_pin_the_same_canonical_installation_home(self):
        alias = self.root / 'logical-home'
        app = self.home / 'app'; app.mkdir(parents=True)
        (app / 'install_pc_support.py').write_bytes(b'# fixture')
        python = self.root / 'python.exe'; python.write_bytes(b'fixture')
        (self.root / 'pythonw.exe').write_bytes(b'fixture')
        original = Path.resolve
        def resolved(path, *args, **kwargs):
            if path.is_relative_to(alias):
                return original(self.home / path.relative_to(alias), *args, **kwargs)
            return original(path, *args, **kwargs)
        def save_shortcut(command, **kwargs):
            Path(kwargs['env']['STUDIO_PC_LNK_STAGE']).write_bytes(b'fixture shortcut')
        registry = MagicMock()
        with patch.object(Path, 'resolve', resolved), patch.dict(sys.modules, {'winreg': registry}), patch.object(installer.subprocess, 'run', side_effect=save_shortcut) as run:
            installer.write_shortcuts(alias, alias / 'app', python)
            installer.configure_startup(alias / 'app', python, True, home=alias)
            installer.create_start_menu_shortcut(alias / 'app', python, home=alias, roaming=self.root / 'Roaming')
        commands = [registry.SetValueEx.call_args.args[4], run.call_args.kwargs['env']['STUDIO_PC_LNK_ARGUMENTS'],
                    (self.home / 'check-pc-support.cmd').read_text(encoding='utf-8'),
                    (self.home / 'restart-pc-support.cmd').read_text(encoding='utf-8')]
        for command in commands:
            self.assertIn('--installation-home', command)
            self.assertIn(str(self.home), command)
            self.assertIn(str(app / 'install_pc_support.py'), command)
            self.assertNotIn('logical-home', command)

    def test_unknown_application_directory_and_changed_source_are_not_overwritten(self):
        app = self.home / 'app'; app.mkdir(parents=True)
        private = app / 'user.txt'; private.write_text('preserve', encoding='utf-8')
        (app / package.MANIFEST).write_text('{"version":1,"package":"someone-else"}', encoding='utf-8')
        with self.assertRaises(ValueError):
            installer.install_application(self.source, home=self.home, local=self.local)
        self.assertEqual(private.read_text(encoding='utf-8'), 'preserve')
        manifest = package.source_manifest(self.source)
        (self.source / package.MANIFEST).write_text(json.dumps(manifest), encoding='utf-8')
        (self.source / 'studio_server.py').write_bytes(b'changed')
        with self.assertRaises(ValueError):
            installer.install_application(self.source, home=self.root / 'newhome', local=self.local)
        self.assertFalse((self.root / 'newhome' / 'app').exists())

    def test_failed_update_restores_existing_files(self):
        app, _ = installer.install_application(self.source, home=self.home, local=self.local)
        old = {name: (app / name).read_bytes() for name in package.PC_FILES[:3]}
        for name in old:
            (self.source / name).write_bytes(b'# new synthetic version\n')
        real_replace = Path.replace
        def fail_once(path, target):
            if Path(target) == app / package.PC_FILES[2]:
                raise OSError('synthetic locked destination')
            return real_replace(path, target)
        with patch.object(Path, 'replace', fail_once), self.assertRaises(OSError):
            installer.install_application(self.source, home=self.home, local=self.local)
        for name, content in old.items():
            self.assertEqual((app / name).read_bytes(), content)

    def test_existing_components_skip_every_setup_and_preserve_metadata(self):
        for name in installer.COMPONENTS:
            self.configured(name)
        before = {p.name: p.read_bytes() for p in self.local.glob('*.json')}
        with patch.object(installer.subprocess, 'run') as run:
            installer.install_components(self.source, self.local, list(installer.COMPONENTS))
            run.assert_not_called()
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.local.glob('*.json')})

    def test_incomplete_component_or_unknown_engine_is_never_overwritten(self):
        path = self.local / 'pc-asr.json'; path.write_text('{"provider":"faster-whisper"}', encoding='utf-8')
        with patch.object(installer.subprocess, 'run') as run, self.assertRaises(RuntimeError):
            installer.install_components(self.source, self.local, ['asr'])
        run.assert_not_called()
        self.assertEqual(path.read_text(encoding='utf-8'), '{"provider":"faster-whisper"}')
        folder = self.local / 'tracking-engine'; folder.mkdir()
        data = folder / 'unrelated.txt'; data.write_bytes(b'keep')
        with patch.object(installer.subprocess, 'run') as run, self.assertRaises(RuntimeError):
            installer.install_components(self.source, self.local, ['tracking'])
        run.assert_not_called()
        self.assertEqual(data.read_bytes(), b'keep')
        self.assertFalse((self.local / 'pc-support-install-tracking.json').exists())

    def test_fresh_asr_and_tracking_setup_see_empty_engine_and_shared_directory(self):
        import setup_pc_asr
        import setup_pc_tracking
        for name, setup in [('asr', setup_pc_asr), ('tracking', setup_pc_tracking)]:
            with self.subTest(name=name):
                def complete(command, **kwargs):
                    engine = Path(command[command.index('--engine-dir') + 1])
                    self.assertFalse(engine.exists() and any(engine.iterdir()))
                    self.assertEqual(Path(command[command.index('--local-dir') + 1]), self.local)
                    self.assertEqual(kwargs['env']['STUDIO_LOCAL_DIR'], str(self.local))
                    setup.claim_engine_directory(engine)
                    self.configured(name)
                with patch.object(installer.subprocess, 'run', side_effect=complete) as run:
                    installer.install_components(self.source, self.local, [name])
                run.assert_called_once()
                self.assertEqual(installer.component_state(self.local, name), 'configured')
                self.assertTrue((self.local / ('pc-support-install-' + name + '.json')).is_file())

    def test_failed_new_setup_can_resume_only_its_owned_directory(self):
        import setup_pc_asr
        engine = self.local / 'asr-engine'
        def interrupted(*args, **kwargs):
            setup_pc_asr.claim_engine_directory(engine)
            (engine / 'download.part').write_bytes(b'partial synthetic download')
            raise subprocess.CalledProcessError(1, ['synthetic'])
        with patch.object(installer.subprocess, 'run', side_effect=interrupted), self.assertRaises(subprocess.CalledProcessError):
            installer.install_components(self.source, self.local, ['asr'])
        with patch.object(installer.subprocess, 'run', side_effect=lambda *a, **k: self.configured('asr')):
            installer.install_components(self.source, self.local, ['asr'])
        self.assertEqual((engine / 'download.part').read_bytes(), b'partial synthetic download')

    def test_bridge_health_authenticates_before_sending_management_key(self):
        key = self.bridge_key()
        with patch.object(installer, '_port_open', side_effect=[True, False]), patch.object(installer, '_http', side_effect=self.fake_http(key)) as http:
            self.assertTrue(installer.stop_bridge(self.local))
        self.assertEqual([call.args[0] for call in http.call_args_list], ['/api/pc-bridge/health', '/api/pc-bridge/shutdown'])

    def test_http_timeout_is_bounded_and_defaults_to_short_health_budget(self):
        response = Mock()
        response.status = 200
        response.headers.get_content_type.return_value = 'application/json'
        response.read.return_value = b'{}'
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value = response
        with patch.object(installer, 'build_opener', return_value=opener) as factory:
            self.assertEqual(installer._http('/api/pc-bridge/health'), {})
            self.assertEqual(opener.open.call_args.kwargs['timeout'], 2)
            self.assertEqual(installer._http('/api/pc-bridge/shutdown', data=b'{}', timeout=20), {})
            self.assertEqual(opener.open.call_args.kwargs['timeout'], 20)
            for timeout in (0, True, -1, 31, float('inf'), float('nan'), None, '2'):
                with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                    installer._http('/api/pc-bridge/health', timeout=timeout)
        self.assertEqual(factory.call_count, 2)
        self.assertEqual(opener.open.call_count, 2)

    def test_shutdown_timeout_or_error_never_retries_or_force_stops(self):
        self.bridge_key()
        failures = [(TimeoutError('synthetic timeout'), TimeoutError),
                    (ConnectionResetError('synthetic disconnect'), ConnectionResetError),
                    (ValueError('synthetic invalid response'), ValueError),
                    (RuntimeError('synthetic response failure'), RuntimeError),
                    (HTTPError(installer.BRIDGE_URL, 500, 'synthetic failure', {}, io.BytesIO()), RuntimeError)]
        for failure, expected in failures:
            with self.subTest(failure=type(failure).__name__), patch.object(installer, 'bridge_running', return_value=True), patch.object(installer, '_http', side_effect=failure) as http, patch.object(installer, '_port_open') as port, patch.object(installer.subprocess, 'Popen') as popen, patch.object(installer.subprocess, 'run') as run, patch.object(installer.time, 'sleep') as sleep:
                with self.assertRaises(expected):
                    installer.stop_bridge(self.local)
                http.assert_called_once()
                self.assertEqual(http.call_args.args[0], '/api/pc-bridge/shutdown')
                self.assertEqual(http.call_args.kwargs['timeout'], 20)
                port.assert_not_called(); popen.assert_not_called(); run.assert_not_called(); sleep.assert_not_called()

    def test_unknown_bridge_never_receives_secret_or_shutdown(self):
        self.bridge_key()
        for reply in ({}, {'provider': 'shorts-studio-pc-bridge', 'version': 1, 'nonce': 'bad', 'proof': '0' * 64},
                      {'provider': 'shorts-studio-pc-bridge', 'version': True, 'proof': '한글'}):
            with self.subTest(reply=reply), patch.object(installer, '_port_open', return_value=True), patch.object(installer, '_http', return_value=reply) as http:
                with self.assertRaises(RuntimeError):
                    installer.stop_bridge(self.local)
                http.assert_called_once()
                self.assertEqual(http.call_args.args[0], '/api/pc-bridge/health')
                self.assertNotIn('X-Studio-Bridge-Key', http.call_args.kwargs['headers'])
        with patch.object(installer, '_port_open', return_value=True), patch.object(installer, '_http') as http:
            with self.assertRaises(RuntimeError):
                installer.stop_bridge(self.root / 'no-settings')
            http.assert_not_called()

    def test_busy_bridge_is_not_force_terminated(self):
        key = self.bridge_key()
        healthy = self.fake_http(key)
        def busy(path, **kwargs):
            if path.endswith('/shutdown'):
                raise HTTPError(installer.BRIDGE_URL + path, 409, 'busy', {}, io.BytesIO(b'{}'))
            return healthy(path, **kwargs)
        with patch.object(installer, '_port_open', return_value=True), patch.object(installer, '_http', side_effect=busy), patch.object(installer.subprocess, 'Popen') as popen:
            with self.assertRaisesRegex(RuntimeError, '진행|실행'):
                installer.stop_bridge(self.local)
            popen.assert_not_called()

    def test_start_is_hidden_fixed_port_and_reuses_verified_service(self):
        python = self.root / 'python.exe'; python.write_bytes(b'fixture')
        hidden = self.root / 'pythonw.exe'; hidden.write_bytes(b'fixture')
        process = Mock(); process.poll.return_value = None
        with patch.object(installer, 'bridge_running', side_effect=[False, True]), patch.object(installer.subprocess, 'Popen', return_value=process) as popen:
            self.assertEqual(installer.start_bridge(self.source, self.local, python=python), 'started')
        command = popen.call_args.args[0]
        self.assertEqual(command[0], str(hidden))
        self.assertEqual(command[-2:], ['--port', '8792'])
        self.assertEqual(popen.call_args.kwargs['env']['STUDIO_LOCAL_DIR'], str(self.local))
        self.TrueHidden(popen.call_args.kwargs)
        process.terminate.assert_not_called()
        with patch.object(installer, 'bridge_running', return_value=True), patch.object(installer.subprocess, 'Popen') as popen:
            self.assertEqual(installer.start_bridge(self.source, self.local, python=python), 'reused')
            popen.assert_not_called()

    def TrueHidden(self, kwargs):
        self.assertEqual(kwargs['stdin'], subprocess.DEVNULL)
        self.assertTrue(kwargs['close_fds'])
        if os.name == 'nt':
            self.assertTrue(kwargs['creationflags'] & subprocess.CREATE_NO_WINDOW)
            self.assertTrue(kwargs['creationflags'] & subprocess.DETACHED_PROCESS)

    def test_start_refuses_unknown_listener_and_only_stops_own_failed_launch(self):
        with patch.object(installer, 'bridge_running', side_effect=RuntimeError('unknown listener')), patch.object(installer.subprocess, 'Popen') as popen:
            with self.assertRaises(RuntimeError):
                installer.start_bridge(self.source, self.local)
            popen.assert_not_called()
        process = Mock(); process.poll.return_value = None
        with patch.object(installer, 'bridge_running', return_value=False), patch.object(installer.subprocess, 'Popen', return_value=process), patch.object(installer.time, 'monotonic', side_effect=[0, 31]):
            with self.assertRaises(RuntimeError):
                installer.start_bridge(self.source, self.local, python=sys.executable)
        process.terminate.assert_called_once(); process.wait.assert_called_once_with(timeout=5)

    def test_batch_shortcuts_quote_special_paths_and_preserve_custom_files(self):
        self.home.mkdir()
        app = self.root / 'a&b%PATH%!name'; python = self.root / 'python&%PATH%!.exe'
        installer.write_shortcuts(self.home, app, python)
        command = (self.home / 'check-pc-support.cmd').read_text(encoding='utf-8')
        self.assertIn('DisableDelayedExpansion', command)
        self.assertIn('"' + str(python).replace('%', '%%') + '"', command)
        self.assertIn('"' + str(app / 'install_pc_support.py').replace('%', '%%') + '"', command)
        custom = self.home / 'restart-pc-support.cmd'; custom.write_bytes(b'custom user command')
        with self.assertRaises(RuntimeError):
            installer.write_shortcuts(self.home, app, python)
        self.assertEqual(custom.read_bytes(), b'custom user command')

    def test_noninteractive_base_install_never_enables_startup_or_models(self):
        with patch.object(installer, 'installation_home', return_value=self.home), patch.object(installer, 'read_registration', return_value={}), patch.object(installer, 'local_data_dir', return_value=self.local), patch.object(installer, 'stop_bridge'), patch.object(installer, 'install_application', return_value=(self.home / 'app', self.local)), patch.object(installer, 'install_components') as components, patch.object(installer, 'write_shortcuts'), patch.object(installer, 'create_start_menu_shortcut'), patch.object(installer, 'configure_startup') as startup, patch.object(installer, 'start_bridge', return_value='started'), patch('builtins.input') as prompt:
            self.assertEqual(installer.main(['--yes', '--source', str(self.source)]), 0)
        self.assertEqual(components.call_args.args[2], [])
        startup.assert_not_called(); prompt.assert_not_called()

    @unittest.skipUnless(os.name == 'nt', 'Windows 시작 메뉴 호출은 모의 객체만 사용합니다.')
    def test_start_menu_shortcut_stays_in_programs_and_passes_paths_as_data(self):
        runtime = self.root / 'runtime & percent%value%!'; runtime.mkdir()
        python = runtime / 'python.exe'; python.write_bytes(b'fixture')
        hidden = runtime / 'pythonw.exe'; hidden.write_bytes(b'fixture')
        roaming = self.root / 'Roaming'
        def save_shortcut(command, **kwargs):
            env = kwargs['env']
            self.assertEqual(command[:4], ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command'])
            self.assertNotIn(str(runtime), command[-1])
            self.assertNotIn(str(self.source), command[-1])
            self.assertNotIn('ExecutionPolicy', command[-1])
            self.assertIn("$existing.Description -ne 'Shorts Studio PC support'", command[-1])
            self.assertEqual(env['STUDIO_PC_LNK_PYTHON'], str(hidden))
            self.assertIn('--restart', env['STUDIO_PC_LNK_ARGUMENTS'])
            self.assertTrue(kwargs['creationflags'] & subprocess.CREATE_NO_WINDOW)
            Path(env['STUDIO_PC_LNK_STAGE']).write_bytes(b'fixture shortcut')
        with patch.object(installer.subprocess, 'run', side_effect=save_shortcut) as run:
            target = installer.create_start_menu_shortcut(self.source, python, roaming=roaming)
        self.assertTrue(target.is_relative_to(roaming / 'Microsoft/Windows/Start Menu/Programs'))
        self.assertEqual(target.name, 'Shorts Studio PC.lnk')
        self.assertEqual(target.read_bytes(), b'fixture shortcut')
        self.assertFalse((roaming / 'Desktop').exists())
        run.assert_called_once()

    @unittest.skipUnless(os.name == 'nt', 'Windows 시작 메뉴 호출은 모의 객체만 사용합니다.')
    def test_start_menu_rejects_network_root_and_preserves_an_unrelated_shortcut(self):
        python = self.root / 'python.exe'; python.write_bytes(b'fixture')
        (self.root / 'pythonw.exe').write_bytes(b'fixture')
        with patch.object(installer.subprocess, 'run') as run, self.assertRaises(ValueError):
            installer.create_start_menu_shortcut(self.source, python, roaming=r'\\invalid-host\not-accessed')
        run.assert_not_called()
        roaming = self.root / 'Roaming'
        target = roaming / 'Microsoft/Windows/Start Menu/Programs/Shorts Studio/Shorts Studio PC.lnk'
        target.parent.mkdir(parents=True); target.write_bytes(b'unrelated shortcut')
        with patch.object(installer.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['synthetic'])):
            with self.assertRaises(RuntimeError):
                installer.create_start_menu_shortcut(self.source, python, roaming=roaming)
        self.assertEqual(target.read_bytes(), b'unrelated shortcut')

    @unittest.skipUnless(os.name == 'nt', 'Windows 레지스트리 호출은 모의 객체만 사용합니다.')
    def test_startup_changes_only_explicit_owned_run_value(self):
        python = self.root / 'python.exe'; python.write_bytes(b'fixture')
        (self.root / 'pythonw.exe').write_bytes(b'fixture')
        registry = MagicMock()
        with patch.dict(sys.modules, {'winreg': registry}):
            installer.configure_startup(self.source, python, True)
            installer.configure_startup(self.source, python, False)
        self.assertEqual(registry.CreateKey.call_count, 2)
        self.assertEqual(registry.SetValueEx.call_args.args[1], 'ShortsStudioPCSupport')
        self.assertIn('--start', registry.SetValueEx.call_args.args[4])
        self.assertNotIn('--enable-startup', registry.SetValueEx.call_args.args[4])
        self.assertEqual(registry.DeleteValue.call_args.args[1], 'ShortsStudioPCSupport')

    @unittest.skipUnless(os.name == 'nt', 'Windows PowerShell 구문 검사 전용입니다.')
    def test_generated_bootstrap_parses_without_executing_downloads(self):
        for name, command in [('local.cmd', package.bootstrap_cmd()), ('download.cmd', package.bootstrap_cmd('a' * 64, 1234))]:
            (self.root / name).write_bytes(command.encode('utf-8'))
            self.assertLess(max(map(len, command.splitlines())), 8000)
            self.assertNotIn('ExecutionPolicy', command)
            self.assertNotIn('Invoke-Expression', command)
            self.assertNotIn('EncodedCommand', command)
        python = self.root / 'python.exe'; python.write_bytes(b'fixture')
        (self.root / 'pythonw.exe').write_bytes(b'fixture')
        def save_shortcut(command, **kwargs):
            Path(kwargs['env']['STUDIO_PC_LNK_STAGE']).write_bytes(b'fixture shortcut')
        with patch.object(installer.subprocess, 'run', side_effect=save_shortcut) as create:
            installer.create_start_menu_shortcut(self.source, python, roaming=self.root / 'Roaming')
        (self.root / 'shortcut-script.txt').write_text(create.call_args.args[0][-1], encoding='utf-8')
        script = r'''
$ErrorActionPreference='Stop'
foreach($name in @('local.cmd','download.cmd')) {
  $line=[IO.File]::ReadAllLines((Join-Path $env:STUDIO_PARSE_FIXTURE $name)) | Where-Object {$_.StartsWith('powershell.exe ')}
  $prefix='-Command "'
  $body=$line.Substring($line.IndexOf($prefix)+$prefix.Length)
  $body=$body.Substring(0,$body.Length-1)
  $tokens=$null;$errors=$null
  [Management.Automation.Language.Parser]::ParseInput($body,[ref]$tokens,[ref]$errors)|Out-Null
  if($errors.Count -gt 0){throw ($errors|Out-String)}
}
$tokens=$null;$errors=$null
$body=[IO.File]::ReadAllText((Join-Path $env:STUDIO_PARSE_FIXTURE 'shortcut-script.txt'))
[Management.Automation.Language.Parser]::ParseInput($body,[ref]$tokens,[ref]$errors)|Out-Null
if($errors.Count -gt 0){throw ($errors|Out-String)}
'''
        result = subprocess.run(['powershell.exe', '-NoProfile', '-Command', script], env={**os.environ, 'STUDIO_PARSE_FIXTURE': str(self.root)}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_setup_writes_to_shared_directory_without_touching_reference_data(self):
        import setup_vox_voice
        import setup_pc_asr
        reference = self.local / 'synthetic-reference.txt'; reference.write_bytes(b'keep synthetic reference')
        engine = self.root / 'vox'; model = engine / 'model'; model.mkdir(parents=True)
        python = engine / 'python.exe'; python.write_bytes(b'fixture')
        with patch.object(setup_vox_voice, 'local_data_dir', return_value=self.local), patch.object(setup_vox_voice, 'register_installation') as registration:
            settings = setup_vox_voice.write_config(engine, model, python, 'cuda')
            first_key = settings['engineKey']
            again = setup_vox_voice.write_config(engine, model, python, 'cuda')
        self.assertEqual(first_key, again['engineKey'])
        self.assertEqual(settings['references'], str(self.local / 'voices'))
        self.assertEqual(registration.call_args.args[0], self.local)
        asr = self.root / 'asr'; asr.mkdir()
        with patch.object(setup_pc_asr, 'local_data_dir', return_value=self.local), patch.object(setup_pc_asr, 'register_installation'):
            setup_pc_asr.write_config(asr, model, python, 'cuda', [], local=None)
        self.assertTrue((self.local / 'pc-asr.json').is_file())
        self.assertEqual(reference.read_bytes(), b'keep synthetic reference')


if __name__ == '__main__':
    unittest.main()
