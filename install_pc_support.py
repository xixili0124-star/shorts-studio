"""PC 지원 파일 설치와 인증된 로컬 연결 서비스 시작을 한곳에서 처리합니다."""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from build_pc_support_package import (PACKAGE_ID, MANIFEST, no_links, source_manifest, validate_manifest)
from pc_installation import installation_home, local_data_dir, read_registration, register_installation

ROOT = Path(__file__).resolve().parent
BRIDGE_URL = 'http://127.0.0.1:8792'
BRIDGE_PORT = 8792
COMPONENTS = {
    'voice': {'label': 'VoxCPM2 내 목소리', 'script': 'setup_vox_voice.py', 'directory': 'vox-engine',
              'configs': ('pc-voice-voxcpm2.json', 'pc-voice.json'), 'provider': 'voxcpm2', 'download': '모델 약 5GB + 별도 실행 환경, 여유 15GB 이상'},
    'asr': {'label': 'Whisper Turbo 자막', 'script': 'setup_pc_asr.py', 'directory': 'asr-engine',
            'configs': ('pc-asr.json',), 'provider': 'faster-whisper', 'download': '모델 약 1.62GB + 별도 실행 환경, 여유 8GB 이상'},
    'tracking': {'label': 'SAM 2.1 Small 추적', 'script': 'setup_pc_tracking.py', 'directory': 'tracking-engine',
                 'configs': ('pc-tracking.json',), 'provider': 'sam2', 'download': '추적 모델과 별도 GPU 실행 환경'},
}


def _json_file(path, limit=16384):
    path = Path(path)
    if path.is_symlink():
        raise ValueError('링크 설정 파일은 읽지 않습니다.')
    if not path.exists():
        return None
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400 or info.st_size > limit:
        raise ValueError('설정 파일 경로나 크기가 올바르지 않습니다.')
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise ValueError('설정 파일의 형식이 올바르지 않습니다.')
    return data


def _local_directory(path):
    path = Path(os.path.abspath(path))
    if str(path).startswith(('\\\\', '//')) or path == Path(path.anchor):
        raise ValueError('개인 PC의 하위 폴더를 선택해 주세요.')
    for part in [path, *path.parents]:
        if part.is_symlink() or (part.exists() and getattr(part.lstat(), 'st_file_attributes', 0) & 0x400):
            raise ValueError('링크나 재분석 지점에는 PC 지원 파일을 설치하지 않습니다.')
    return path


def _canonical_local_path(path):
    """AppData 가상 경로 대신 Win32에서 확인되는 실제 경로를 실행 명령에 씁니다."""
    return _local_directory(_local_directory(path).resolve())


def install_application(source, *, home=None, local=None, python=None):
    """허용 파일만 교체하며 원본 모델·녹음이나 알 수 없는 기존 파일은 건드리지 않습니다."""
    source = _canonical_local_path(source)
    home = _canonical_local_path(home or installation_home())
    app = home / 'app'
    local = _local_directory(local or local_data_dir(source, home))
    marker = _json_file(source / MANIFEST, 65536)
    manifest = validate_manifest(marker) if marker is not None else source_manifest(source)
    content = {}
    for item in manifest['files']:
        path = source / item['path']; no_links(path, source)
        if not path.is_file() or path.stat().st_size != item['size']:
            raise ValueError('설치 원본 파일이 없거나 크기가 다릅니다: ' + item['path'])
        value = path.read_bytes()
        if hashlib.sha256(value).hexdigest() != item['sha256']:
            raise ValueError('설치 원본 검증에 실패했습니다: ' + item['path'])
        content[item['path']] = value
    if app.exists() and any(app.iterdir()):
        installed = _json_file(app / MANIFEST, 65536)
        if not installed or installed.get('package') != PACKAGE_ID or installed.get('version') != 1:
            raise ValueError('설치 폴더에 다른 파일이 있습니다. 기존 파일은 덮어쓰지 않았습니다.')
    for name in content:
        target = app / name; no_links(target, home)
        if target.exists() and not target.is_file():
            raise ValueError('프로그램 파일 위치에 다른 폴더가 있습니다.')
    home.mkdir(parents=True, exist_ok=True)
    # 처음 만든 AppData 폴더도 MSIX 환경에서는 다른 실제 위치로 갈 수 있습니다.
    home = _canonical_local_path(home)
    app = _canonical_local_path(home / 'app')
    local = _canonical_local_path(local)
    stage = _local_directory(home / 'staging' / secrets.token_hex(16))
    stage.mkdir(parents=True, exist_ok=False)
    for name, value in content.items():
        target = stage / name; target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(value)
    manifest_stage = stage / MANIFEST
    manifest_stage.write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True), encoding='utf-8')
    backup = _local_directory(home / 'backups' / secrets.token_hex(16))
    replaced = []
    try:
        for name, value in content.items():
            target = app / name; target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists() and target.read_bytes() == value:
                continue
            old = None
            if target.exists():
                old = backup / name; old.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, old)
            (stage / name).replace(target)
            replaced.append((target, old, value))
        manifest_stage.replace(app / MANIFEST)
    except BaseException:
        for target, old, value in reversed(replaced):
            no_links(target, app)
            if old is not None:
                shutil.copy2(old, target)
            elif target.is_file() and target.read_bytes() == value:
                # 이번 설치가 만든 파일만 되돌리고 기존 사용자 파일은 지우지 않습니다.
                target.unlink()
        raise
    # 실행 경로만 저장합니다. 목소리 폴더나 비공개 엔진 키는 복사하지 않습니다.
    register_installation(local, app=app, python=_canonical_local_path(python or sys.executable), home=home)
    return app, local


def component_state(local, name):
    spec = COMPONENTS[name]
    for filename in spec['configs']:
        try:
            data = _json_file(Path(local) / filename)
            if data is None:
                continue
            if data.get('provider', 'gpt-sovits') != spec['provider']:
                if filename == 'pc-voice.json':
                    continue
                return 'incomplete'
            paths = [Path(data[key]) for key in ('python', 'engine', 'model')]
            if any(not path.is_absolute() or str(path).startswith(('\\\\', '//')) for path in paths):
                return 'incomplete'
            if not paths[0].is_file() or not all(path.is_dir() for path in paths[1:]):
                return 'incomplete'
            if name == 'voice' and not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', data.get('engineKey', '')):
                return 'incomplete'
            return 'configured'
        except (OSError, ValueError, TypeError, KeyError):
            return 'incomplete'
    return 'absent'


def install_components(app, local, names, *, python=None, uv=None, device='cuda'):
    python = str(python or sys.executable)
    local = _local_directory(local)
    for name in names:
        if name not in COMPONENTS:
            raise ValueError('알 수 없는 PC 기능입니다.')
        spec, state = COMPONENTS[name], component_state(local, name)
        if state == 'configured':
            print(spec['label'] + ': 기존 설치를 재사용합니다. 모델과 참고 녹음은 변경하지 않습니다.', flush=True)
            continue
        if state == 'incomplete':
            raise RuntimeError(spec['label'] + ': 기존 설정을 확인하지 못했습니다. 기존 파일을 보존했으니 도움말에서 설치 상태를 확인해 주세요.')
        engine = _local_directory(Path(local) / spec['directory'])
        owner = Path(local) / ('pc-support-install-' + name + '.json')
        no_links(owner, local)
        expected = {'package': PACKAGE_ID, 'component': name, 'engine': str(engine)}
        if engine.exists() and any(engine.iterdir()) and _json_file(owner) != expected:
            raise RuntimeError('기존 엔진 폴더의 파일을 덮어쓰지 않았습니다: ' + spec['label'])
        owner.parent.mkdir(parents=True, exist_ok=True)
        if not owner.exists():
            owner.write_text(json.dumps(expected), encoding='utf-8')
        elif _json_file(owner) != expected:
            raise RuntimeError('이전 기능 설치 경로가 다릅니다. 기존 파일은 변경하지 않았습니다.')
        command = [python, str(Path(app) / spec['script']), '--yes', '--local-dir', str(local), '--engine-dir', str(engine)]
        if name != 'tracking':
            command.extend(['--device', device])
        if sys.version_info[:2] == (3, 11):
            command.extend(['--python', python])
        if uv:
            command.extend(['--uv', str(uv)])
        environment = {**os.environ, 'STUDIO_LOCAL_DIR': str(local), 'PYTHONUTF8': '1'}
        subprocess.run(command, cwd=app, env=environment, check=True)
        if component_state(local, name) != 'configured':
            raise RuntimeError(spec['label'] + ': 설치가 끝났지만 실행 설정을 확인하지 못했습니다.')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        return None


def _http(path, *, headers=None, data=None, timeout=2):
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout <= 30:
        raise ValueError('PC 연결 요청의 제한 시간은 0초 초과 30초 이하여야 합니다.')
    request = Request(BRIDGE_URL + path, headers={'Accept': 'application/json', **(headers or {})}, data=data)
    opener = build_opener(ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=timeout) as response:
        if response.status != 200 or response.headers.get_content_type() != 'application/json':
            raise RuntimeError('PC 연결 응답을 확인하지 못했습니다.')
        raw = response.read(16385)
    if len(raw) > 16384:
        raise RuntimeError('PC 연결 응답이 너무 큽니다.')
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise RuntimeError('PC 연결 응답의 형식이 올바르지 않습니다.')
    return result


def _port_open():
    with socket.socket() as sock:
        sock.settimeout(.3)
        return sock.connect_ex(('127.0.0.1', BRIDGE_PORT)) == 0


def _management_key(local):
    data = _json_file(Path(local) / 'pc-bridge-key.json') or {}
    key = data.get('key')
    if not isinstance(key, str) or not re.fullmatch(r'[a-f0-9]{64}', key):
        raise RuntimeError('기존 연결 서비스의 관리 정보를 확인하지 못했습니다. 다른 프로그램은 중지하지 않습니다.')
    return key


def bridge_running(local):
    if not _port_open():
        return False
    key, nonce = _management_key(local), secrets.token_hex(16)
    try:
        reply = _http('/api/pc-bridge/health', headers={'X-Studio-Bridge-Nonce': nonce})
    except (OSError, URLError, ValueError) as error:
        raise RuntimeError('8792 포트가 사용 중이지만 Shorts Studio 연결 서비스로 인증하지 못했습니다.') from error
    expected = hmac.new(key.encode(), ('studio-pc-bridge-v1:' + nonce).encode(), hashlib.sha256).hexdigest()
    proof = reply.get('proof')
    if (reply.get('provider') != 'shorts-studio-pc-bridge' or type(reply.get('version')) is not int
            or reply['version'] != 1 or reply.get('nonce') != nonce or not isinstance(proof, str)
            or not re.fullmatch(r'[a-f0-9]{64}', proof) or not hmac.compare_digest(proof, expected)):
        raise RuntimeError('8792 포트의 프로그램이 설치된 연결 서비스와 다릅니다. 관리 키를 보내지 않았습니다.')
    return True


def stop_bridge(local, *, timeout=30):
    if not bridge_running(local):
        return False
    try:
        # 종료 전 엔진 상태 확인과 정리를 기다리되 실패한 요청을 재전송하지 않습니다.
        _http('/api/pc-bridge/shutdown', headers={'Content-Type': 'application/json', 'X-Studio-Bridge-Key': _management_key(local)}, data=b'{}', timeout=20)
    except HTTPError as error:
        if error.code == 409:
            raise RuntimeError('실행 중인 음성·자막·추적 작업을 마치거나 취소한 뒤 다시 시작해 주세요.') from error
        raise RuntimeError('인증된 PC 연결 서비스가 종료 요청을 거절했습니다.') from error
    deadline = time.monotonic() + timeout
    while _port_open():
        if time.monotonic() >= deadline:
            raise RuntimeError('PC 연결 서비스 종료를 확인하지 못했습니다. 다른 프로세스는 종료하지 않았습니다.')
        time.sleep(.1)
    return True


def start_bridge(app, local, *, python=None, timeout=30):
    if bridge_running(local):
        return 'reused'
    app, local = _canonical_local_path(app), _canonical_local_path(local)
    python = _canonical_local_path(python or sys.executable)
    hidden_python = python.with_name('pythonw.exe')
    executable = hidden_python if hidden_python.is_file() else python
    if not executable.is_file() or not (app / 'studio_server.py').is_file():
        raise RuntimeError('PC 연결 프로그램이나 Python 파일을 찾지 못했습니다.')
    logs = _local_directory(local / 'logs'); logs.mkdir(parents=True, exist_ok=True)
    log = logs / ('pc-support-' + time.strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(3) + '.log')
    environment = {**os.environ, 'STUDIO_LOCAL_DIR': str(local), 'PYTHONUTF8': '1'}
    flags = (getattr(subprocess, 'CREATE_NO_WINDOW', 0) | getattr(subprocess, 'DETACHED_PROCESS', 0)
             | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)) if os.name == 'nt' else 0
    with log.open('xb') as output:
        process = subprocess.Popen([str(executable), '-E', '-s', '-X', 'utf8', str(app / 'studio_server.py'),
                                    '--port', str(BRIDGE_PORT)], cwd=app, env=environment,
                                   stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                   close_fds=True, creationflags=flags)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError('PC 연결 프로그램이 종료되었습니다. 설치 로그를 확인해 주세요: ' + str(log))
        try:
            if bridge_running(local):
                return 'started'
        except (RuntimeError, OSError, ValueError):
            pass
        time.sleep(.2)
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
    raise RuntimeError('PC 연결 시작을 확인하지 못했습니다. 설치 로그: ' + str(log))


def configure_startup(app, python, enabled, *, home=None):
    """명시적인 선택이 있을 때만 현재 사용자의 자동 시작 항목 하나를 바꿉니다."""
    if os.name != 'nt':
        raise RuntimeError('Windows에서만 자동 시작을 설정할 수 있습니다.')
    import winreg
    app, python = _canonical_local_path(app), _canonical_local_path(python)
    home = _canonical_local_path(home or app.parent)
    hidden = python.with_name('pythonw.exe')
    if enabled and not hidden.is_file():
        raise RuntimeError('숨김 실행용 pythonw.exe가 없어 자동 시작을 설정하지 않았습니다.')
    command = subprocess.list2cmdline([str(hidden), '-E', '-s', '-X', 'utf8', str(app / 'install_pc_support.py'),
                                     '--start', '--installation-home', str(home)])
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Run') as key:
        if enabled:
            winreg.SetValueEx(key, 'ShortsStudioPCSupport', 0, winreg.REG_SZ, command)
        else:
            try:
                winreg.DeleteValue(key, 'ShortsStudioPCSupport')
            except FileNotFoundError:
                pass


def write_shortcuts(home, app, python):
    home = _canonical_local_path(home)
    app, python = _canonical_local_path(app), _canonical_local_path(python)
    def batch_path(value):
        value = str(value)
        if any(char in value for char in ('"', '\r', '\n', '\x00')):
            raise ValueError('확인·재시작 파일 경로가 올바르지 않습니다.')
        return '"' + value.replace('%', '%%') + '"'
    for name, argument in [('check-pc-support.cmd', '--check'), ('restart-pc-support.cmd', '--restart')]:
        path = home / name; no_links(path, home)
        command = (batch_path(python) + ' -E -s -X utf8 ' + batch_path(app / 'install_pc_support.py')
                   + ' ' + argument + ' --installation-home ' + batch_path(home))
        content = ('@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\nrem Shorts Studio PC support\r\n'
                   + command + '\r\nset "STUDIO_SETUP_EXIT=%errorlevel%"\r\npause\r\nexit /b %STUDIO_SETUP_EXIT%\r\n')
        if path.exists() and 'rem Shorts Studio PC support' not in path.read_text(encoding='utf-8'):
            raise RuntimeError('기존 확인·재시작 파일을 덮어쓰지 않았습니다.')
        path.write_bytes(content.encode('utf-8'))


def create_start_menu_shortcut(app, python, *, roaming=None, home=None):
    """시작 메뉴에 소유 표식이 있는 바로가기 하나만 만듭니다. 자동 실행은 별도입니다."""
    if os.name != 'nt':
        raise RuntimeError('시작 메뉴 바로가기는 Windows에서만 만들 수 있습니다.')
    roaming = roaming or os.environ.get('APPDATA')
    if not roaming:
        raise RuntimeError('현재 사용자의 시작 메뉴 위치를 찾지 못했습니다.')
    roaming = _local_directory(roaming)
    programs = _local_directory(roaming / 'Microsoft' / 'Windows' / 'Start Menu' / 'Programs')
    folder = _local_directory(programs / 'Shorts Studio')
    target = folder / 'Shorts Studio PC.lnk'
    if not target.is_relative_to(programs):
        raise ValueError('현재 사용자의 시작 메뉴 범위를 벗어났습니다.')
    no_links(target, roaming)
    app, python = _canonical_local_path(app), _canonical_local_path(python)
    home = _canonical_local_path(home or app.parent)
    hidden = python.with_name('pythonw.exe')
    if not hidden.is_file() or not (app / 'install_pc_support.py').is_file():
        raise RuntimeError('시작 메뉴에 연결할 PC 프로그램이나 pythonw.exe가 없습니다.')
    folder.mkdir(parents=True, exist_ok=True)
    stage = folder / ('Shorts Studio PC.' + secrets.token_hex(8) + '.lnk')
    arguments = subprocess.list2cmdline(['-E', '-s', '-X', 'utf8', str(app / 'install_pc_support.py'),
                                       '--restart', '--installation-home', str(home)])
    environment = {**os.environ, 'STUDIO_PC_LNK_TARGET': str(target), 'STUDIO_PC_LNK_STAGE': str(stage),
                   'STUDIO_PC_LNK_PYTHON': str(hidden), 'STUDIO_PC_LNK_ARGUMENTS': arguments,
                   'STUDIO_PC_LNK_APP': str(app)}
    # 경로는 환경 변수로 전달해 PowerShell 코드로 해석되지 않게 합니다.
    script = r'''
$ErrorActionPreference='Stop'
$shell=New-Object -ComObject WScript.Shell
if(Test-Path -LiteralPath $env:STUDIO_PC_LNK_TARGET){
  $existing=$shell.CreateShortcut($env:STUDIO_PC_LNK_TARGET)
  if($existing.Description -ne 'Shorts Studio PC support'){throw 'An unrelated shortcut already exists.'}
}
$shortcut=$shell.CreateShortcut($env:STUDIO_PC_LNK_STAGE)
$shortcut.TargetPath=$env:STUDIO_PC_LNK_PYTHON
$shortcut.Arguments=$env:STUDIO_PC_LNK_ARGUMENTS
$shortcut.WorkingDirectory=$env:STUDIO_PC_LNK_APP
$shortcut.Description='Shorts Studio PC support'
$shortcut.WindowStyle=7
$shortcut.IconLocation=$env:STUDIO_PC_LNK_PYTHON+',0'
$shortcut.Save()
'''
    try:
        subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], env=environment,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                       check=True, timeout=30, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except subprocess.SubprocessError:
        raise RuntimeError('시작 메뉴 바로가기를 만들지 못했습니다. 기존 바로가기는 덮어쓰지 않았습니다.') from None
    no_links(stage, roaming)
    if not stage.is_file() or not 0 < stage.stat().st_size <= 65536:
        raise RuntimeError('생성한 시작 메뉴 바로가기를 확인하지 못했습니다.')
    stage.replace(target)
    return target


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--check', action='store_true', help='설정·기본 경로와 인증된 연결 서비스 상태만 확인, 설치·GPU 추론 없음')
    action.add_argument('--start', action='store_true', help='등록된 연결 서비스를 시작하거나 이미 실행 중이면 재사용')
    action.add_argument('--restart', action='store_true', help='인증된 연결 서비스만 정상 종료 후 시작, 진행 중인 작업이 있으면 거절')
    parser.add_argument('--source', type=Path, default=ROOT, help='허용 목록의 공개 PC 프로그램 소스 폴더')
    parser.add_argument('--installation-home', type=Path, help='바로가기에 고정한 실제 설치 등록 폴더, 실행·검사는 이 폴더만 사용')
    parser.add_argument('--local-dir', type=Path, help='기존 모델 설정·참고 녹음의 공유 폴더, 생략하면 등록된 경로 유지')
    parser.add_argument('--components', nargs='*', choices=COMPONENTS, default=None, help='설치할 기능, 이미 설정된 기능은 재사용')
    parser.add_argument('--device', choices=('cuda', 'cpu'), default='cuda')
    parser.add_argument('--yes', action='store_true', help='Confirm only the explicitly listed components')
    startup = parser.add_mutually_exclusive_group()
    startup.add_argument('--enable-startup', action='store_true', help='Windows 로그인 때 연결 서비스 시작에 명시적으로 동의')
    startup.add_argument('--disable-startup', action='store_true', help='이 앱의 Windows 자동 시작 등록만 해제')
    args = parser.parse_args(argv)
    if os.name != 'nt' or platform.machine().lower() not in ('amd64', 'x86_64'):
        raise RuntimeError('이 설치기는 Windows x64용입니다.')
    home = _canonical_local_path(args.installation_home or installation_home())
    registration = read_registration(home) or {}
    if args.installation_home and (args.start or args.restart or args.check) and not registration:
        raise RuntimeError('지정한 PC 설치 등록 정보를 찾지 못했습니다. 다른 폴더나 서비스로 전환하지 않습니다.')
    registered_local = registration.get('localDir') if args.installation_home else None
    local = _canonical_local_path(args.local_dir or registered_local or local_data_dir(args.source, home))
    app = Path(registration.get('appDir') or home / 'app')
    python = Path(registration.get('python') or sys.executable)
    if args.check:
        print(json.dumps({'bridge': 'running' if bridge_running(local) else 'stopped',
                          'components': {name: component_state(local, name) for name in COMPONENTS}}, ensure_ascii=False, indent=2))
        return 0
    if args.start or args.restart:
        if args.restart:
            stop_bridge(local)
        print('PC 연결: ' + start_bridge(app, local, python=python), flush=True)
        return 0
    if not args.yes and input('PC 연결 프로그램을 설치할까요? 모델·참고 녹음은 삭제하지 않습니다. [y/N] ').strip().lower() not in ('y', 'yes'):
        return 0
    names = args.components
    if names is None:
        names = []
        if not args.yes:
            for name, spec in COMPONENTS.items():
                state = component_state(local, name)
                if state == 'configured':
                    print(spec['label'] + ': 기존 설치 재사용', flush=True)
                elif state == 'incomplete':
                    print(spec['label'] + ': 기존 설정 확인 필요 · 파일은 유지합니다.', flush=True)
                elif input(spec['label'] + '도 설치할까요? ' + spec['download'] + ' [y/N] ').strip().lower() in ('y', 'yes'):
                    names.append(name)
    elif names and not args.yes:
        if input('선택한 기능의 대용량 다운로드를 진행할까요? [y/N] ').strip().lower() not in ('y', 'yes'):
            return 0
    enable_startup = args.enable_startup
    if not args.yes and not args.enable_startup and not args.disable_startup:
        enable_startup = input('Windows 로그인 때 PC 연결 서비스를 자동 시작할까요? [y/N] ').strip().lower() in ('y', 'yes')
    stop_bridge(local)
    app, local = install_application(args.source, home=home, local=local, python=sys.executable)
    home = app.parent
    uv = home / 'runtime' / 'uv.exe'
    install_components(app, local, names, uv=uv if uv.is_file() else None, device=args.device)
    write_shortcuts(home, app, sys.executable)
    create_start_menu_shortcut(app, sys.executable, home=home)
    if enable_startup or args.disable_startup:
        configure_startup(app, sys.executable, enable_startup, home=home)
    print('PC 연결: ' + start_bridge(app, local), flush=True)
    print('설치가 끝났습니다. 원래 편집기의 도움말 → PC 연결 → 설치 확인을 누르세요. 브라우저는 설치 파일을 자동 실행하지 않습니다.', flush=True)
    print('다음에는 시작 메뉴의 Shorts Studio PC를 실행하세요. Windows 자동 시작은 명시적으로 동의한 경우에만 등록합니다.', flush=True)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print('PC 지원 설치를 마치지 못했습니다: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
