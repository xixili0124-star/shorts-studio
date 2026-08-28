"""Isolated GPT-SoVITS runtime: Korean compatibility, offline imports, private API."""
import argparse
from contextlib import redirect_stdout, redirect_stderr
import ipaddress
import json
import os
from pathlib import Path
import runpy
import re
import secrets
import socket
import sys

from pc_voice import local_engine_key, engine_proof


def loopback_host(host):
    if isinstance(host, bytes):
        host = host.decode('ascii', errors='ignore')
    if host == 'localhost':
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except (ValueError, TypeError):
        return False


def restrict_engine_network():
    """Guard this Python process only. Installation is a separate online command."""
    def require_loopback(host):
        if not loopback_host(host):
            raise OSError('The PC voice engine only permits loopback network access.')
    original_getaddrinfo = socket.getaddrinfo
    def local_getaddrinfo(host, *args, **kwargs):
        require_loopback(host)
        return original_getaddrinfo(host, *args, **kwargs)
    socket.getaddrinfo = local_getaddrinfo
    for name in ('gethostbyname', 'gethostbyname_ex', 'gethostbyaddr'):
        original = getattr(socket, name)
        def local_resolve(host, _original=original):
            require_loopback(host)
            return _original(host)
        setattr(socket, name, local_resolve)
    for name in ('connect', 'connect_ex', 'bind'):
        original = getattr(socket.socket, name)
        def local_address(self, address, _original=original):
            if not isinstance(address, tuple):
                raise OSError('Only loopback IP sockets are supported.')
            require_loopback(address[0])
            return _original(self, address)
        setattr(socket.socket, name, local_address)
    original_sendto = socket.socket.sendto
    def local_sendto(self, data, *args):
        address = args[-1]
        if not isinstance(address, tuple):
            raise OSError('Only loopback IP sockets are supported.')
        require_loopback(address[0])
        return original_sendto(self, data, *args)
    socket.socket.sendto = local_sendto


def read_settings(path):
    path = Path(path).resolve()
    if path.stat().st_size > 16384:
        raise RuntimeError('Invalid PC voice settings')
    settings = json.loads(path.read_text(encoding='utf-8'))
    if not local_engine_key(path):
        raise RuntimeError('PC voice setup is incomplete. Run setup-pc-voice.cmd first.')
    for name in ('engine', 'config', 'data', 'bin', 'python'):
        if not isinstance(settings.get(name), str) or not Path(settings[name]).is_absolute():
            raise RuntimeError('Invalid PC voice settings')
    return settings


def configure_environment(settings):
    source, data = Path(settings['engine']), Path(settings['data'])
    if not (data / 'resources-ready.json').is_file():
        raise RuntimeError('Offline pronunciation resources are not installed.')
    required = [source / 'api_v2.py', Path(settings['config']),
        source / 'GPT_SoVITS/pretrained_models/fast_langdetect/lid.176.bin',
        data / 'nltk_data/corpora/cmudict.zip',
        data / 'nltk_data/taggers/averaged_perceptron_tagger.zip',
        data / 'nltk_data/taggers/averaged_perceptron_tagger_eng/averaged_perceptron_tagger_eng.weights.json']
    if any(not path.is_file() for path in required):
        raise RuntimeError('A PC voice resource is missing. Run setup again.')
    private_dirs = {'HF_HOME': data / 'huggingface', 'TORCH_HOME': data / 'torch',
                    'MPLCONFIGDIR': data / 'matplotlib', 'NUMBA_CACHE_DIR': data / 'numba',
                    'TEMP': data / 'temp', 'TMP': data / 'temp'}
    for name, directory in private_dirs.items():
        directory.mkdir(parents=True, exist_ok=True)
        os.environ[name] = str(directory)
    os.environ.update({'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
        'HF_HUB_DISABLE_TELEMETRY': '1', 'DO_NOT_TRACK': '1', 'TOKENIZERS_PARALLELISM': 'false',
        'NLTK_DATA': str(data / 'nltk_data'), 'PATH': settings['bin'] + os.pathsep + os.environ.get('PATH', '')})
    os.chdir(source)
    sys.path[:0] = [str(source), str(source / 'GPT_SoVITS')]


def install_korean_compatibility():
    # No third-party source is modified. Keep these aliases inside this process.
    import jieba
    import jieba.posseg
    sys.modules['jieba_fast'] = jieba
    sys.modules['jieba_fast.posseg'] = jieba.posseg
    from g2pk2 import G2p
    from mecab import MeCab
    def check_mecab(self):
        MeCab()  # Raises on a missing dictionary; never invokes pip/eunjeon.
    def get_mecab(self):
        return MeCab()
    G2p.check_mecab = check_mecab
    G2p.get_mecab = get_mecab


def build_app(settings, port):
    configure_environment(settings)
    restrict_engine_network()
    install_korean_compatibility()
    sys.argv = ['api_v2.py', '-a', '127.0.0.1', '-p', str(port), '-c', settings['config']]
    namespace = runpy.run_path(str(Path(settings['engine']) / 'api_v2.py'), run_name='studio_private_sovits')
    app = namespace['APP']
    # Even loopback must reject websites trying to call /control or weight setters.
    app.router.routes = [route for route in app.router.routes
        if (route.path == '/openapi.json' and 'GET' in route.methods)
        or (route.path == '/tts' and 'POST' in route.methods)]
    app.openapi_schema = None
    from fastapi import Request
    from starlette.responses import JSONResponse
    @app.get('/studio/health')
    async def health(request: Request):
        nonce = request.headers.get('x-studio-engine-nonce', '')
        if not re.fullmatch(r'[a-f0-9]{32}', nonce):
            return JSONResponse({'error': 'Invalid engine challenge'}, status_code=400)
        return {'service': 'shorts-studio-pc-voice', 'protocol': 1, 'model': 'v2ProPlus',
            'proof': engine_proof(settings['engineKey'], nonce)}
    @app.middleware('http')
    async def private_engine(request, call_next):
        # Only a bounded nonce is signed here; no key, voice or path is exposed.
        # Verify this signature before sending the private key to other routes.
        if (request.method, request.url.path) == ('GET', '/studio/health'):
            return await call_next(request)
        supplied = request.headers.get('x-studio-engine-key', '')
        allowed = (request.method, request.url.path) in {('GET', '/openapi.json'), ('POST', '/tts')}
        if not allowed or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', supplied) or not secrets.compare_digest(supplied, settings['engineKey']):
            return JSONResponse({'error': 'Private PC voice engine'}, status_code=403)
        return await call_next(request)
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--settings', required=True, type=Path)
    parser.add_argument('--port', default=9880, type=int)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        raise RuntimeError('Invalid voice engine port')
    settings = read_settings(args.settings)
    status_file = Path(settings['data']) / 'runtime-status.json'
    def status(state, error=None):
        status_file.write_text(json.dumps({'state': state, 'errorType': error}), encoding='utf-8')
    status('loading')
    try:
        # Upstream prints reference text/paths; do not leave them in console logs.
        with open(os.devnull, 'w', encoding='utf-8') as discard, redirect_stdout(discard), redirect_stderr(discard):
            app = build_app(settings, args.port)
            import uvicorn
            status('loaded')
            uvicorn.run(app, host='127.0.0.1', port=args.port, workers=1, access_log=False, log_level='error')
        status('stopped')
    except Exception as error:
        status('failed', type(error).__name__)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
