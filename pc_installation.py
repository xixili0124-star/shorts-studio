"""편집기 폴더가 바뀌어도 사용자가 설치한 PC 엔진과 참고 음성을 찾습니다."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG_NAMES = ('pc-voice.json', 'pc-asr.json', 'pc-tracking.json')


def installation_home():
    base = Path(os.environ.get('LOCALAPPDATA') or (Path.home() / '.local' / 'share'))
    return base / 'ShortsStudio'


def _local_path(value):
    if not isinstance(value, str) or not value or len(value) > 4096 or value.startswith(('\\\\', '//')):
        raise ValueError('PC 설치 경로가 올바르지 않습니다.')
    path = Path(value)
    if not path.is_absolute():
        raise ValueError('PC 설치 경로는 절대 경로여야 합니다.')
    return path.resolve()


def read_registration(home=None):
    path = Path(home or installation_home()) / 'installation.json'
    try:
        if path.is_symlink() or path.stat().st_size > 16384:
            return None
        data = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(data, dict) or data.get('version') != 1:
            return None
        local = _local_path(data.get('localDir'))
        if not local.is_dir():
            return None
        return {**data, 'localDir': str(local)}
    except (OSError, ValueError, TypeError):
        return None


def local_data_dir(root=None, home=None):
    """전체 디스크를 검색하지 않고 등록 경로와 기존 앱 위치만 확인합니다."""
    root = Path(root or ROOT).resolve()
    explicit = os.environ.get('STUDIO_LOCAL_DIR')
    if explicit:
        return _local_path(explicit)
    registration = read_registration(home)
    if registration:
        return Path(registration['localDir'])
    candidates = [root / '.studio-local']
    if root.name in ('shorts-studio-main-integration', 'shorts-studio-publish', 'shorts-studio-lab'):
        candidates.extend([root.parent / 'shorts-studio-publish' / '.studio-local',
                           root.parent / 'shorts-studio-main-integration' / '.studio-local',
                           root.parent.parent / 'outputs' / 'shorts-studio-lab' / '.studio-local'])
    for candidate in candidates:
        if any((candidate / name).is_file() for name in CONFIG_NAMES):
            return candidate.resolve()
    return Path(home or installation_home()) / 'data'


def register_installation(local, app=None, python=None, home=None):
    """설치 실행 시에만 경로를 저장합니다. 목소리나 엔진 키는 복사하지 않습니다."""
    local = _local_path(str(Path(local).absolute()))
    local.mkdir(parents=True, exist_ok=True)
    home = Path(home or installation_home())
    home.mkdir(parents=True, exist_ok=True)
    data = {'version': 1, 'localDir': str(local)}
    if app:
        data['appDir'] = str(_local_path(str(Path(app).absolute())))
    if python:
        data['python'] = str(_local_path(str(Path(python).absolute())))
    target = home / 'installation.json'
    if target.is_symlink():
        raise ValueError('설치 정보 파일이 다른 위치를 가리킵니다.')
    temporary = target.with_suffix('.json.tmp')
    if temporary.is_symlink():
        raise ValueError('설치 정보 임시 파일이 다른 위치를 가리킵니다.')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(target)
    return data
