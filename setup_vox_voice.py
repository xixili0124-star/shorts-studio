"""Install pinned VoxCPM2 in its own Windows environment; never upload voice data."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys

from pc_voice_config import activate_config, read_config, settings_path
from setup_pc_voice import download, prepare_uv, sha256, PYTHON_VERSION

ROOT = Path(__file__).resolve().parent
PACKAGE_VERSION = '2.0.3'
SOURCE_REV = '19b6bf7590025418821a86dcb817504e0ad7e5df'
MODEL_REV = '32279effe8c19989596f05d353d1447f51d9e915'
WHEEL_URL = 'https://files.pythonhosted.org/packages/f5/50/76e912427684f7e71d443d9542802ad33df8764ef3bba954b96feeab41ba/voxcpm-2.0.3-py3-none-any.whl'
WHEEL_HASH = '24da58a30d094a9e9a7ead450ae9cffda0d31eaeba620b61ad99179dd87e486b'
MODEL_FILES = {
    'model.safetensors': (4580080592, 'f7f964cfa9da23653baec6e6f7750719977ad944ed9f95fe52fe3a620506891d'),
    'audiovae.pth': (376951122, '94b5d51e107e0507d4acc976cfdadb64edd6fd06d1f751dadbf2fd1594274bf1'),
    'config.json': (4336, None),
    'tokenizer.json': (3676772, None),
    'tokenizer_config.json': (5059, None),
    'special_tokens_map.json': (1632, None),
    'README.md': (7939, None),
}


def prepare_models(engine):
    model = engine / 'model'
    def one(item):
        name, (size, digest) = item
        download('https://huggingface.co/openbmb/VoxCPM2/resolve/' + MODEL_REV + '/' + name,
                 model / name, digest, size)
        return name, {'size': size, 'sha256': digest or sha256(model / name)}
    with ThreadPoolExecutor(max_workers=3) as pool:
        files = dict(pool.map(one, MODEL_FILES.items()))
    marker = {'provider': 'voxcpm2', 'modelRevision': MODEL_REV, 'files': files}
    temporary = model / 'studio-model-ready.json.tmp'
    temporary.write_text(json.dumps(marker, indent=2), encoding='utf-8')
    temporary.replace(model / 'studio-model-ready.json')
    return model


def prepare_runtime(engine, device, python_path=None, uv_path=None):
    uv = Path(uv_path).resolve() if uv_path else prepare_uv(engine)
    env = {**os.environ, 'UV_CACHE_DIR': str(engine / 'cache'), 'UV_PYTHON_INSTALL_DIR': str(engine / 'python'),
           'HF_HUB_OFFLINE': '1', 'HF_HUB_DISABLE_TELEMETRY': '1', 'DO_NOT_TRACK': '1'}
    if python_path:
        managed = str(Path(python_path).resolve())
    else:
        subprocess.run([str(uv), 'python', 'install', PYTHON_VERSION, '--no-bin', '--no-registry'], env=env, check=True)
        managed = subprocess.check_output([str(uv), 'python', 'find', PYTHON_VERSION, '--managed-python'], env=env, text=True).strip()
    python = engine / 'venv' / 'Scripts' / 'python.exe'
    if not python.exists():
        subprocess.run([str(uv), 'venv', '--python', managed, str(engine / 'venv')], env=env, check=True)
    channel = 'cu124' if device == 'cuda' else 'cpu'
    subprocess.run([str(uv), 'pip', 'install', '--python', str(python), '--index-url',
                    'https://download.pytorch.org/whl/' + channel, 'torch==2.5.1', 'torchaudio==2.5.1'], env=env, check=True)
    subprocess.run([str(uv), 'pip', 'install', '--python', str(python), '-r',
                    str(ROOT / 'vox-voice-requirements.txt')], env=env, check=True)
    wheel = engine / 'downloads' / 'voxcpm-2.0.3-py3-none-any.whl'
    download(WHEEL_URL, wheel, WHEEL_HASH, 88270)
    # Avoid unrelated UI/ASR/denoising dependencies in the full upstream extra set.
    subprocess.run([str(uv), 'pip', 'install', '--python', str(python), '--no-deps', str(wheel)], env=env, check=True)
    probe = ('import torch, torchaudio, librosa, soundfile, fastapi, uvicorn; '
             'from voxcpm import VoxCPM; '
             'assert torch.__version__.startswith("2.5.1"); ' +
             ('assert torch.cuda.is_available(), "A supported NVIDIA CUDA GPU is required"; ' if device == 'cuda' else '') +
             'print("VoxCPM2 inference imports verified")')
    subprocess.run([str(python), '-c', probe], env=env, check=True)
    return python


def write_config(engine, model, python, device):
    local = ROOT / '.studio-local'
    key = secrets.token_urlsafe(32)
    try:
        key = read_config(settings_path(local, 'voxcpm2'))['engineKey']
    except (OSError, ValueError):
        pass
    (engine / 'data').mkdir(parents=True, exist_ok=True)
    settings = {'provider': 'voxcpm2', 'python': str(python), 'engine': str(engine), 'model': str(model),
                'data': str(engine / 'data'), 'references': str(local / 'voices'), 'device': device,
                'packageVersion': PACKAGE_VERSION, 'sourceRevision': SOURCE_REV, 'modelRevision': MODEL_REV, 'engineKey': key}
    activate_config(local, settings)
    return settings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--yes', action='store_true')
    parser.add_argument('--engine-dir', type=Path, default=ROOT / '.studio-local' / 'vox-engine')
    parser.add_argument('--device', choices=('cuda', 'cpu'), default='cuda')
    parser.add_argument('--download-only', action='store_true')
    parser.add_argument('--prepare-only', action='store_true', help='Verify installation without activating it')
    parser.add_argument('--python', type=Path, help='Existing Python 3.11 used to create a separate venv')
    parser.add_argument('--uv', type=Path, help='Existing uv executable')
    args = parser.parse_args()
    if os.name != 'nt':
        raise RuntimeError('This installer supports Windows x64.')
    if not args.yes and input('Download VoxCPM2 weights (~5 GB) and a separate runtime (several GB)? [y/N] ').strip().lower() != 'y':
        return
    engine = args.engine_dir.resolve()
    engine.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(engine).free < 15 * 1024**3:
        raise RuntimeError('Please make at least 15 GB of free disk space available.')
    model = prepare_models(engine)
    if args.download_only:
        return
    python = prepare_runtime(engine, args.device, args.python, args.uv)
    if args.prepare_only:
        print('VoxCPM2 files and inference imports verified. Existing engine is still active.', flush=True)
        return
    write_config(engine, model, python, args.device)
    print('VoxCPM2 is installed. Save your project, stop the old PC launcher, then run start-pc-voice.cmd.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError, ValueError, KeyError) as error:
        print('VoxCPM2 setup did not finish: ' + str(error), file=sys.stderr)
        sys.exit(1)
