"""Explicit, isolated Windows setup for the optional PC voice engine (no user audio)."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import secrets
import subprocess
import sys
import urllib.request
import zipfile

SOURCE_REV = '48b1a0169a28582a8984402f82cf438d3bfa6aca'
MODEL_REV = '336b2ec4e8d4ac74740798dd40af44e74659ecaf'
PYTHON_VERSION = '3.11.13'
UV_VERSION = '0.12.7'
MODEL_HASHES = {
    's1v3.ckpt': '87133414860ea14ff6620c483a3db5ed07b44be42e2c3fcdad65523a729a745a',
    'v2Pro/s2Gv2ProPlus.pth': 'd42a22bbbf65fb2bbdd45ad6a66841156977db45c7aabe0a6992ff378d9c7d3b',
    'sv/pretrained_eres2netv2w24s4ep4.ckpt': '4f5a0bf73c61eb41b174e1bb54e7ee3c83233892be8e0af1f187024e8e581a35',
    'chinese-hubert-base/pytorch_model.bin': '24164f129c66499d1346e2aa55f183250c223161ec2770c0da3d3b08cf432d3c',
    'chinese-roberta-wwm-ext-large/pytorch_model.bin': 'e53a693acc59ace251d143d068096ae0d7b79e4b1b503fa84c9dcf576448c1d8',
}
ROOT = Path(__file__).resolve().parent


def get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'ShortsStudio-PC-Voice-Setup'}), timeout=60) as response:
        return json.load(response)


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def download(url, path, digest=None, size=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and (size is None or path.stat().st_size == size) and digest and sha256(path) == digest:
        print('Verified: ' + path.name, flush=True)
        return
    temporary = path.with_name(path.name + '.part')
    request = urllib.request.Request(url, headers={'User-Agent': 'ShortsStudio-PC-Voice-Setup'})
    with urllib.request.urlopen(request, timeout=120) as response, temporary.open('wb') as stream:
        shutil.copyfileobj(response, stream, length=1024 * 1024)
    if (size is not None and temporary.stat().st_size != size) or (digest and sha256(temporary) != digest):
        raise RuntimeError('Download verification failed: ' + path.name)
    temporary.replace(path)
    print('Downloaded: ' + path.name + ' (' + str(path.stat().st_size // 1024) + ' KB)', flush=True)


def prepare_source(engine):
    source = engine / 'source'
    marker = source / '.studio-source-revision'
    if marker.exists() and marker.read_text().strip() == SOURCE_REV:
        return source
    if source.exists() and any(source.iterdir()):
        raise RuntimeError('Source folder already exists with a different version. Choose an empty engine folder.')
    archive = engine / 'downloads' / ('source-' + SOURCE_REV + '.zip')
    download('https://codeload.github.com/RVC-Boss/GPT-SoVITS/zip/' + SOURCE_REV, archive)
    with zipfile.ZipFile(archive) as bundle:
        if sum(item.file_size for item in bundle.infolist()) > 256 * 1024 * 1024:
            raise RuntimeError('Unexpected source archive size')
        for item in bundle.infolist():
            parts = PurePosixPath(item.filename).parts[1:]
            if not parts:
                continue
            if any(part in ('..', '.') or ':' in part or '\\' in part for part in parts) or (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise RuntimeError('Unsafe archive entry')
            destination = source.joinpath(*parts)
            if not destination.resolve().is_relative_to(source.resolve()):
                raise RuntimeError('Unsafe archive path')
            if item.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(item) as original, destination.open('wb') as target:
                    shutil.copyfileobj(original, target)
    marker.write_text(SOURCE_REV, encoding='ascii')
    return source


def prepare_models(source):
    metadata = get_json('https://huggingface.co/api/models/lj1995/GPT-SoVITS/revision/' + MODEL_REV + '?blobs=true')
    siblings = {item['rfilename']: item for item in metadata['siblings']}
    names = [name for name in siblings if name in MODEL_HASHES or name.startswith(('chinese-hubert-base/', 'chinese-roberta-wwm-ext-large/'))]
    if not MODEL_HASHES.keys() <= set(names):
        raise RuntimeError('Required model files are missing from the pinned revision')
    def one(name):
        item = siblings[name]
        digest = MODEL_HASHES.get(name) or item.get('lfs', {}).get('sha256')
        if name in MODEL_HASHES and item.get('lfs', {}).get('sha256') != digest:
            raise RuntimeError('Model metadata does not match the pinned SHA-256')
        path = source / 'GPT_SoVITS' / 'pretrained_models' / name
        if not path.resolve().is_relative_to((source / 'GPT_SoVITS' / 'pretrained_models').resolve()):
            raise RuntimeError('Unsafe model path')
        download('https://huggingface.co/lj1995/GPT-SoVITS/resolve/' + MODEL_REV + '/' + name, path, digest, item.get('size'))
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(one, names))


def prepare_uv(engine):
    executable = engine / 'tools' / 'uv.exe'
    if executable.exists():
        return executable
    info = get_json('https://pypi.org/pypi/uv/' + UV_VERSION + '/json')
    wheel = next(item for item in info['urls'] if item['filename'].endswith('py3-none-win_amd64.whl'))
    archive = engine / 'downloads' / wheel['filename']
    download(wheel['url'], archive, wheel['digests']['sha256'], wheel['size'])
    with zipfile.ZipFile(archive) as bundle:
        member = next(name for name in bundle.namelist() if name.endswith('/uv.exe'))
        executable.parent.mkdir(parents=True, exist_ok=True)
        executable.write_bytes(bundle.read(member))
    return executable


def write_config(engine, source, python, device):
    config = engine / ('studio-voice-' + device + '.yaml')
    values = {'device': device, 'is_half': device == 'cuda', 'version': 'v2ProPlus',
              't2s_weights_path': 'GPT_SoVITS/pretrained_models/s1v3.ckpt',
              'vits_weights_path': 'GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth',
              'cnhuhbert_base_path': 'GPT_SoVITS/pretrained_models/chinese-hubert-base',
              'bert_base_path': 'GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large'}
    # JSON is valid YAML; only trusted local paths are written here.
    config_temp = config.with_suffix('.yaml.tmp')
    config_temp.write_text(json.dumps({'custom': values}, indent=2), encoding='utf-8')
    config_temp.replace(config)
    local = ROOT / '.studio-local'
    local.mkdir(exist_ok=True)
    previous = {}
    try:
        previous = json.loads((local / 'pc-voice.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        pass
    key = previous.get('engineKey', '')
    if not isinstance(key, str) or len(key) < 32:
        key = secrets.token_urlsafe(32)
    settings = {'python': str(python), 'engine': str(source), 'config': str(config),
                'data': str(engine / 'data'), 'bin': str(engine / 'bin'),
                'sourceRevision': SOURCE_REV, 'modelRevision': MODEL_REV, 'device': device, 'engineKey': key}
    settings_temp = local / 'pc-voice.json.tmp'
    settings_temp.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding='utf-8')
    settings_temp.replace(local / 'pc-voice.json')
    return settings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--yes', action='store_true', help='Confirm the optional multi-GB download')
    parser.add_argument('--engine-dir', type=Path, default=ROOT / '.studio-local' / 'engine')
    parser.add_argument('--device', choices=('cuda', 'cpu'), default='cuda')
    parser.add_argument('--download-only', action='store_true')
    args = parser.parse_args()
    if os.name != 'nt':
        raise RuntimeError('This installer supports Windows x64. Other systems can connect their own local GPT-SoVITS API.')
    if not args.yes and input('Download optional PC voice models/resources (~1.5 GB) and runtime (several GB)? [y/N] ').strip().lower() != 'y':
        return
    engine = args.engine_dir.resolve()
    engine.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(engine).free < 10 * 1024**3:
        raise RuntimeError('Please make at least 10 GB of free disk space available.')
    source = prepare_source(engine)
    prepare_models(source)
    if args.download_only:
        return
    uv = prepare_uv(engine)
    env = {**os.environ, 'UV_CACHE_DIR': str(engine / 'cache'), 'UV_PYTHON_INSTALL_DIR': str(engine / 'python')}
    subprocess.run([str(uv), 'python', 'install', PYTHON_VERSION, '--no-bin', '--no-registry'], env=env, check=True)
    managed = subprocess.check_output([str(uv), 'python', 'find', PYTHON_VERSION, '--managed-python'], env=env, text=True).strip()
    python = engine / 'venv' / 'Scripts' / 'python.exe'
    if not python.exists():
        subprocess.run([str(uv), 'venv', '--python', managed, str(engine / 'venv')], env=env, check=True)
    channel = 'cu124' if args.device == 'cuda' else 'cpu'
    subprocess.run([str(uv), 'pip', 'install', '--python', str(python), '--index-url', 'https://download.pytorch.org/whl/' + channel,
                    'torch==2.5.1', 'torchaudio==2.5.1'], env=env, check=True)
    subprocess.run([str(uv), 'pip', 'install', '--python', str(python), '-r', str(ROOT / 'pc-voice-requirements.txt')], env=env, check=True)
    subprocess.run([str(python), str(ROOT / 'prepare_pc_voice_resources.py'), '--engine-data', str(engine / 'data'), '--source', str(source), '--bin', str(engine / 'bin')], env=env, check=True)
    write_config(engine, source, python, args.device)
    print('PC voice installation finished. Run start-pc-voice.cmd, then open the local editor.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError, ValueError, KeyError) as error:
        print('PC voice setup did not finish: ' + str(error), file=sys.stderr)
        sys.exit(1)
