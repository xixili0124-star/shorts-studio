"""명시적으로 실행했을 때만 SAM 2.1 Small과 별도 Windows 추적 환경을 준비한다."""

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import zipfile

from pc_tracking_worker import (MODEL_ID, MODEL_NAME, MODEL_REV, SOURCE_REV,
    MODEL_FILE, MODEL_FILES, MODEL_MARKER, TORCH_VERSION, TORCHVISION_VERSION,
    SAM_PACKAGE_VERSION, offline_environment)
from pc_installation import local_data_dir, register_installation
from setup_pc_voice import download, prepare_uv, PYTHON_VERSION


ROOT = Path(__file__).resolve().parent
ENVIRONMENT_MARKER = 'studio-tracking-environment.json'
SOURCE_ARCHIVE_SIZE = 55952852
SOURCE_ARCHIVE_SHA256 = 'fe93082a71a885a427894b1eab76341768781b6b58a298a0717e03862097d137'


def write_json_atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise RuntimeError('Unsafe tracking configuration destination.')
    temporary = path.with_name(path.name + '.tmp')
    if temporary.is_symlink():
        raise RuntimeError('Unsafe tracking temporary configuration.')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def claim_engine_directory(engine):
    path = Path(engine)
    if path.is_symlink():
        raise RuntimeError('Choose a separate tracking engine directory without links.')
    engine = path.resolve()
    if engine == ROOT or ROOT.is_relative_to(engine):
        raise RuntimeError('Choose a separate empty tracking engine directory.')
    marker = engine / ENVIRONMENT_MARKER
    if engine.exists() and any(engine.iterdir()):
        if not marker.is_file() or marker.is_symlink() or marker.stat().st_size > 8192:
            raise RuntimeError('This folder contains unrelated files. Choose an empty tracking engine directory is required.')
        installed = json.loads(marker.read_text(encoding='utf-8'))
        if (not isinstance(installed, dict) or installed.get('provider') != 'sam2'
                or installed.get('version') != 1 or installed.get('sourceRevision') != SOURCE_REV):
            raise RuntimeError('This folder belongs to another environment or source version.')
    engine.mkdir(parents=True, exist_ok=True)
    write_json_atomic(marker, {'version': 1, 'provider': 'sam2', 'modelRevision': MODEL_REV,
                              'sourceRevision': SOURCE_REV, 'pythonVersion': PYTHON_VERSION})
    return engine


def source_members(bundle):
    """고정된 공식 소스에서 실행·설정·라이선스 파일만 안전하게 추출한다."""
    result = []
    prefix = 'sam2-' + SOURCE_REV
    total = 0
    for item in bundle.infolist():
        if '\\' in item.orig_filename:
            raise RuntimeError('Unsafe SAM source archive separator.')
        parts = PurePosixPath(item.filename).parts
        if not parts or parts[0] != prefix:
            raise RuntimeError('Unexpected SAM source archive root.')
        parts = parts[1:]
        if not parts:
            continue
        # 공식 저장소의 구형 SAM2 설정 별칭 네 개는 사용하지 않으며 링크도 만들지 않는다.
        if ((item.external_attr >> 16) & 0o170000 == 0o120000
                and len(parts) == 2 and parts[0] == 'sam2'
                and parts[1] in ('sam2_hiera_b+.yaml', 'sam2_hiera_l.yaml',
                                 'sam2_hiera_s.yaml', 'sam2_hiera_t.yaml')
                and item.file_size < 128
                and bundle.read(item).decode('ascii') == 'configs/sam2/' + parts[1]):
            continue
        if (any(part in ('.', '..') or ':' in part or '\\' in part for part in parts)
                or (item.external_attr >> 16) & 0o170000 == 0o120000):
            raise RuntimeError('Unsafe SAM source archive entry.')
        if parts[0] != 'sam2' and not (len(parts) == 1 and parts[0] in (
                'LICENSE', 'LICENSE_cctorch', 'README.md', 'MANIFEST.in', 'pyproject.toml', 'setup.py')):
            continue
        total += item.file_size
        if total > 32 * 1024 * 1024 or item.file_size > 8 * 1024 * 1024 or len(result) > 1000:
            raise RuntimeError('Unexpected SAM source file sizes.')
        result.append((item, parts))
    return result


def prepare_source(engine):
    source = engine / 'source'
    marker = source / '.studio-source-revision'
    if source.is_symlink() or marker.is_symlink():
        raise RuntimeError('Unsafe SAM source destination.')
    if marker.is_file() and marker.stat().st_size < 100 and marker.read_text(encoding='ascii').strip() == SOURCE_REV:
        return source
    if source.exists() and any(source.iterdir()):
        raise RuntimeError('An incomplete source folder already exists. Choose a new engine folder is required.')
    archive = engine / 'downloads' / ('sam2-' + SOURCE_REV + '.zip')
    download('https://codeload.github.com/facebookresearch/sam2/zip/' + SOURCE_REV,
             archive, SOURCE_ARCHIVE_SHA256, SOURCE_ARCHIVE_SIZE)
    if archive.stat().st_size > 256 * 1024 * 1024:
        raise RuntimeError('Unexpected SAM source archive size.')
    with zipfile.ZipFile(archive) as bundle:
        members = source_members(bundle)
        for item, parts in members:
            destination = source.joinpath(*parts)
            if not destination.resolve().is_relative_to(source.resolve()) or destination.is_symlink():
                raise RuntimeError('Unsafe SAM source output path.')
            if item.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(item) as original, destination.open('wb') as target:
                    shutil.copyfileobj(original, target)
    if not (source / 'sam2' / 'configs' / 'sam2.1' / 'sam2.1_hiera_s.yaml').is_file():
        raise RuntimeError('SAM 2.1 Small source configuration is missing.')
    marker.write_text(SOURCE_REV, encoding='ascii')
    return source


def prepare_models(engine):
    model = engine / 'model'
    if model.is_symlink():
        raise RuntimeError('Unsafe tracking model destination.')
    files = {}
    for name, (size, digest) in MODEL_FILES.items():
        target = model / name
        if target.is_symlink() or target.resolve().parent != model.resolve():
            raise RuntimeError('Unsafe tracking model file destination.')
        download('https://huggingface.co/' + MODEL_ID + '/resolve/' + MODEL_REV + '/' + name,
                 target, digest, size)
        files[name] = {'size': size, 'sha256': digest}
    write_json_atomic(model / MODEL_MARKER,
                      {'provider': 'sam2', 'modelName': MODEL_NAME, 'modelId': MODEL_ID,
                       'modelRevision': MODEL_REV, 'sourceRevision': SOURCE_REV, 'files': files})
    return model


def runtime_environment(engine):
    environment = offline_environment()
    environment.update({'UV_CACHE_DIR': str(engine / 'cache'),
                        'UV_PYTHON_INSTALL_DIR': str(engine / 'python'),
                        'SAM2_BUILD_CUDA': '0'})
    return environment


def prepare_runtime(engine, source, python_path=None, uv_path=None):
    uv = Path(uv_path).resolve() if uv_path else prepare_uv(engine)
    if not uv.is_file():
        raise RuntimeError('The uv executable was not found.')
    env = runtime_environment(engine)
    if python_path:
        managed = str(Path(python_path).resolve())
    else:
        subprocess.run([str(uv), 'python', 'install', PYTHON_VERSION, '--no-bin', '--no-registry'],
                       env=env, check=True)
        managed = subprocess.check_output([str(uv), 'python', 'find', PYTHON_VERSION, '--managed-python'],
                                          env=env, text=True).strip()
    subprocess.run([managed, '-I', '-c',
                    'import sys,struct; assert sys.version_info[:2] == (3,11); assert struct.calcsize("P") == 8'],
                   env=env, check=True)
    python = engine / 'venv' / 'Scripts' / 'python.exe'
    if not python.exists():
        subprocess.run([str(uv), 'venv', '--python', managed, str(engine / 'venv')],
                       env=env, check=True)
    # 이 가상환경에서만 설치하며 CUDA 확장 컴파일러나 외부 영상 도구는 요구하지 않는다.
    subprocess.run([str(uv), 'pip', 'install', '--python', str(python),
                    'torch==' + TORCH_VERSION, 'torchvision==' + TORCHVISION_VERSION,
                    '--index-url', 'https://download.pytorch.org/whl/cu124'], env=env, check=True)
    subprocess.run([str(uv), 'pip', 'install', '--python', str(python),
                    '-r', str(ROOT / 'pc-tracking-requirements.txt')], env=env, check=True)
    subprocess.run([str(uv), 'pip', 'install', '--python', str(python),
                    '--no-build-isolation', '--no-deps', str(source)], env=env, check=True)
    subprocess.run([str(uv), 'pip', 'check', '--python', str(python)], env=env, check=True)
    return python


def verify_runtime(engine, python, model):
    """사용자 영상 없이 설치 파일·CUDA 장치·패키지 import만 확인한다."""
    probe = '''
import importlib.metadata
import json
import sys
sys.path.insert(0, sys.argv[1])
import pc_tracking_worker as worker
worker.configure_offline()
worker.validate_model_directory(sys.argv[2])
import av
import numpy
import torch
import torchvision
from sam2.build_sam import build_sam2_video_predictor
assert torch.__version__ == worker.TORCH_VERSION
assert torchvision.__version__ == worker.TORCHVISION_VERSION
assert importlib.metadata.version('SAM-2') == worker.SAM_PACKAGE_VERSION
assert torch.cuda.is_available()
assert torch.cuda.is_bf16_supported()
print(json.dumps({'verified': True, 'device': 'cuda', 'computeType': 'bfloat16'}))
'''
    result = subprocess.run([str(python), '-I', '-c', probe, str(ROOT), str(model)],
                            env=runtime_environment(engine), capture_output=True,
                            text=True, encoding='utf-8', errors='replace', timeout=180)
    if result.returncode:
        raise RuntimeError('Tracking runtime verification failed. Check the NVIDIA driver, BF16 support and Visual C++ runtime.')
    try:
        value = json.loads(result.stdout)
        if value != {'verified': True, 'device': 'cuda', 'computeType': 'bfloat16'}:
            raise ValueError()
    except (ValueError, UnicodeError):
        raise RuntimeError('Tracking runtime verification did not return the expected result.') from None


def write_config(engine, source, model, python, local=None):
    """추적 설정만 활성화하며 기존 음성·자동자막 설정은 읽거나 변경하지 않는다."""
    local = Path(local) if local is not None else local_data_dir(ROOT)
    settings = {'version': 1, 'provider': 'sam2', 'modelName': MODEL_NAME,
                'modelId': MODEL_ID, 'modelRevision': MODEL_REV, 'sourceRevision': SOURCE_REV,
                'python': str(python.resolve()), 'engine': str(engine.resolve()),
                'source': str(source.resolve()), 'model': str(model.resolve()),
                'device': 'cuda', 'computeType': 'bfloat16',
                'torchVersion': TORCH_VERSION, 'samPackageVersion': SAM_PACKAGE_VERSION}
    write_json_atomic(local / 'pc-tracking.json', settings)
    register_installation(local, app=ROOT, python=sys.executable)
    return settings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--yes', action='store_true')
    parser.add_argument('--engine-dir', type=Path)
    parser.add_argument('--local-dir', type=Path)
    parser.add_argument('--python', type=Path)
    parser.add_argument('--uv', type=Path)
    parser.add_argument('--download-only', action='store_true')
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    if os.name != 'nt':
        raise RuntimeError('This installer supports Windows x64 and an NVIDIA BF16 GPU.')
    if not args.yes:
        answer = input('Download SAM 2.1 Small (~184 MB) and a separate CUDA runtime (several GB)? [y/N] ')
        if answer.strip().lower() not in ('y', 'yes'):
            return
    local = args.local_dir.resolve() if args.local_dir else local_data_dir(ROOT)
    engine = claim_engine_directory(args.engine_dir or local / 'tracking-engine')
    if shutil.disk_usage(engine).free < 8 * 1024 ** 3:
        raise RuntimeError('Please make at least 8 GB of free disk space available.')
    source = prepare_source(engine)
    model = prepare_models(engine)
    if args.download_only:
        print('Pinned SAM files prepared. Runtime and active settings were not changed.', flush=True)
        return
    python = prepare_runtime(engine, source, args.python, args.uv)
    verify_runtime(engine, python, model)
    if args.prepare_only:
        print('Tracking environment verified. Active settings were not changed.', flush=True)
        return
    write_config(engine, source, model, python, local)
    print('PC tracking installed. Existing TTS and subtitles are unchanged.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print('PC tracking setup did not finish: ' + str(error), file=sys.stderr)
        sys.exit(1)
