"""PC 자동 자막 환경과 모델을 기존 음성 환경과 분리해 설치한다."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from pc_asr_worker import (MODEL_ID, MODEL_NAME, MODEL_REV, MODEL_FILES, MODEL_MARKER,
                           PACKAGE_VERSION, CT2_VERSION, offline_environment)
from setup_pc_voice import download, prepare_uv, PYTHON_VERSION


ROOT = Path(__file__).resolve().parent
ENVIRONMENT_MARKER = 'studio-asr-environment.json'
CUDA_PACKAGES = (
    {
        'filename': 'nvidia_cublas_cu12-12.8.4.1-py3-none-win_amd64.whl',
        'url': 'https://files.pythonhosted.org/packages/70/61/7d7b3c70186fb651d0fbd35b01dbfc8e755f69fd58f817f3d0f642df20c3/nvidia_cublas_cu12-12.8.4.1-py3-none-win_amd64.whl',
        'size': 567544208,
        'sha256': '47e9b82132fa8d2b4944e708049229601448aaad7e6f296f630f2d1a32de35af',
    },
    {
        'filename': 'nvidia_cuda_runtime_cu12-12.8.90-py3-none-win_amd64.whl',
        'url': 'https://files.pythonhosted.org/packages/30/a5/a515b7600ad361ea14bfa13fb4d6687abf500adc270f19e89849c0590492/nvidia_cuda_runtime_cu12-12.8.90-py3-none-win_amd64.whl',
        'size': 944318,
        'sha256': 'c0c6027f01505bfed6c3b21ec546f69c687689aad5f1a377554bc6ca4aa993a8',
    },
)


def write_json_atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def claim_engine_directory(engine):
    """다른 가상환경을 재사용하거나 기존 파일을 덮어쓰지 않도록 소유 표식을 확인한다."""
    engine = Path(engine).resolve()
    if engine == ROOT or ROOT.is_relative_to(engine):
        raise RuntimeError('Choose a separate empty ASR engine directory.')
    marker = engine / ENVIRONMENT_MARKER
    if engine.exists() and any(engine.iterdir()):
        if not marker.is_file() or marker.is_symlink() or marker.stat().st_size > 8192:
            raise RuntimeError('The engine directory already contains unrelated files. Choose an empty directory.')
        installed = json.loads(marker.read_text(encoding='utf-8'))
        if not isinstance(installed, dict) or installed.get('provider') != 'faster-whisper' or installed.get('version') != 1:
            raise RuntimeError('This engine directory belongs to another installation.')
    engine.mkdir(parents=True, exist_ok=True)
    write_json_atomic(marker, {'version': 1, 'provider': 'faster-whisper',
                              'pythonVersion': PYTHON_VERSION, 'packageVersion': PACKAGE_VERSION,
                              'ctranslate2Version': CT2_VERSION, 'modelRevision': MODEL_REV})
    return engine


def prepare_models(engine):
    model = engine / 'model'

    def one(item):
        name, (size, digest) = item
        target = model / name
        if target.is_symlink() or target.resolve().parent != model.resolve():
            raise RuntimeError('Unsafe ASR model destination.')
        download('https://huggingface.co/' + MODEL_ID + '/resolve/' + MODEL_REV + '/' + name,
                 target, digest, size)
        return name, {'size': size, 'sha256': digest}

    with ThreadPoolExecutor(max_workers=3) as pool:
        files = dict(pool.map(one, MODEL_FILES.items()))
    write_json_atomic(model / MODEL_MARKER,
                      {'provider': 'faster-whisper', 'modelName': MODEL_NAME,
                       'modelId': MODEL_ID, 'modelRevision': MODEL_REV, 'files': files})
    return model


def runtime_environment(engine):
    env = offline_environment()
    env.update({'PYTHONUTF8': '1', 'UV_CACHE_DIR': str(engine / 'cache'),
                'UV_PYTHON_INSTALL_DIR': str(engine / 'python')})
    # 호출한 셸의 다른 가상환경·Python 경로가 전용 환경에 섞이지 않도록 한다.
    for key in ('PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV'):
        env.pop(key, None)
    return env


def prepare_runtime(engine, device, python_path=None, uv_path=None):
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
        subprocess.run([str(uv), 'venv', '--python', managed, str(engine / 'venv')], env=env, check=True)
    subprocess.run([str(uv), 'pip', 'install', '--python', str(python), '--only-binary', ':all:',
                    '-r', str(ROOT / 'pc-asr-requirements.txt')], env=env, check=True)
    if device == 'cuda':
        for item in CUDA_PACKAGES:
            wheel = engine / 'downloads' / item['filename']
            download(item['url'], wheel, item['sha256'], item['size'])
            subprocess.run([str(uv), 'pip', 'install', '--python', str(python), '--no-deps', str(wheel)],
                           env=env, check=True)
    subprocess.run([str(uv), 'pip', 'check', '--python', str(python)], env=env, check=True)
    return python


def verify_runtime(engine, python, device):
    """사용자 오디오 없이 import, 번들 VAD, 선택 장치의 정밀도와 DLL을 확인한다."""
    probe = '''
import ctypes
import importlib.metadata
import json
from pathlib import Path
import sys
sys.path.insert(0, sys.argv[1])
import pc_asr_worker as worker
worker.configure_offline()
directories = worker.add_cuda_dll_directories() if sys.argv[2] == 'cuda' else []
libraries = []
for directory in directories:
    for filename in ('cudart64_12.dll', 'cublasLt64_12.dll', 'cublas64_12.dll'):
        if (directory / filename).is_file():
            libraries.append(ctypes.WinDLL(str(directory / filename)))
import av
import numpy
import ctranslate2
import onnxruntime
from faster_whisper import WhisperModel
from faster_whisper.vad import get_vad_model
assert importlib.metadata.version('faster-whisper') == worker.PACKAGE_VERSION
assert ctranslate2.__version__ == worker.CT2_VERSION
onnxruntime.disable_telemetry_events()
get_vad_model()
device = sys.argv[2]
compute_type = 'int8_float16' if device == 'cuda' else 'int8'
assert compute_type in ctranslate2.get_supported_compute_types(device)
if device == 'cuda':
    assert ctranslate2.get_cuda_device_count() > 0
print(json.dumps({'cudaDllDirs': [str(path) for path in directories]}))
'''
    checked = subprocess.run([str(python), '-I', '-c', probe, str(ROOT), device],
                             env=runtime_environment(engine), capture_output=True,
                             text=True, encoding='utf-8', errors='replace', timeout=120)
    if checked.returncode:
        raise RuntimeError('ASR runtime verification failed. Check the selected device, NVIDIA driver and Visual C++ runtime.')
    details = json.loads(checked.stdout)
    directories = details.get('cudaDllDirs')
    if not isinstance(directories, list):
        raise RuntimeError('ASR runtime verification did not return valid DLL directories.')
    for directory in directories:
        path = Path(directory)
        if not path.is_absolute() or not path.is_dir() or not path.resolve().is_relative_to((engine / 'venv').resolve()):
            raise RuntimeError('ASR runtime returned an unexpected DLL directory.')
    return directories


def write_config(engine, model, python, device, cuda_dll_dirs):
    """자동 자막 설정만 활성화하며 PC 음성 설정은 읽거나 변경하지 않는다."""
    settings = {'version': 1, 'provider': 'faster-whisper', 'modelName': MODEL_NAME,
                'modelId': MODEL_ID, 'modelRevision': MODEL_REV,
                'packageVersion': PACKAGE_VERSION, 'ctranslate2Version': CT2_VERSION,
                'python': str(python.resolve()), 'engine': str(engine.resolve()),
                'model': str(model.resolve()), 'device': device,
                'computeType': 'int8_float16' if device == 'cuda' else 'int8',
                'cudaDllDirs': list(cuda_dll_dirs)}
    write_json_atomic(ROOT / '.studio-local' / 'pc-asr.json', settings)
    return settings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--yes', action='store_true')
    parser.add_argument('--engine-dir', type=Path, default=ROOT / '.studio-local' / 'asr-engine')
    parser.add_argument('--device', choices=('cuda', 'cpu'), default='cuda')
    parser.add_argument('--python', type=Path, help='Existing Python 3.11 for the separate ASR venv')
    parser.add_argument('--uv', type=Path, help='Existing uv executable')
    parser.add_argument('--download-only', action='store_true')
    parser.add_argument('--prepare-only', action='store_true', help='Verify without activating ASR configuration')
    args = parser.parse_args()
    if os.name != 'nt':
        raise RuntimeError('This installer supports Windows x64.')
    if not args.yes:
        answer = input('Download PC subtitles model (~1.62 GB) and a separate runtime (CUDA ~0.7 GB extra)? [y/N] ')
        if answer.strip().lower() not in ('y', 'yes'):
            return
    engine = claim_engine_directory(args.engine_dir)
    if shutil.disk_usage(engine).free < 8 * 1024**3:
        raise RuntimeError('Please make at least 8 GB of free disk space available.')
    model = prepare_models(engine)
    if args.download_only:
        print('Pinned ASR model files verified. No runtime or active setting changed.', flush=True)
        return
    python = prepare_runtime(engine, args.device, args.python, args.uv)
    directories = verify_runtime(engine, python, args.device)
    if args.prepare_only:
        print('ASR model and runtime verified. Active settings were not changed.', flush=True)
        return
    write_config(engine, model, python, args.device, directories)
    print('PC subtitles installed. Existing browser subtitles and PC voice settings are unchanged.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError, ValueError, KeyError) as error:
        print('PC subtitles setup did not finish: ' + str(error), file=sys.stderr)
        sys.exit(1)
