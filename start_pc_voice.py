"""Start the local editor and optional private PC voice engine together."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.request import build_opener, ProxyHandler

from pc_voice import NoRedirect, verified_engine
from pc_voice_engine import read_settings
from pc_voice_config import PROVIDERS, provider_of, settings_path as provider_settings_path

ROOT = Path(__file__).resolve().parent


def own_windows_process_tree():
    """Children inherit this job before spawning, including venv redirectors.

    Keep the non-inheritable handle open until this launcher exits. Windows then
    kills every descendant even if Ctrl+C closes only a Python redirector first.
    An engine reused from another launcher is never assigned to this job.
    """
    if os.name != 'nt':
        return None
    import ctypes
    from ctypes import wintypes
    class BasicLimits(ctypes.Structure):
        _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong), ('PerJobUserTimeLimit', ctypes.c_longlong),
            ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
            ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD),
            ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD), ('SchedulingClass', wintypes.DWORD)]
    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in ('ReadOperationCount', 'WriteOperationCount',
            'OtherOperationCount', 'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]
    class ExtendedLimits(ctypes.Structure):
        _fields_ = [('BasicLimitInformation', BasicLimits), ('IoInfo', IoCounters),
            ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
            ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateJobObjectW(None, None)
    if not handle:
        raise RuntimeError('Cannot create a private process group for the PC engine.')
    limits = ExtendedLimits()
    limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        error_code = ctypes.get_last_error()
        kernel.CloseHandle(handle)
        raise RuntimeError(f'Cannot isolate the PC engine process tree (Windows error {error_code}). No engine was started.')
    return handle  # Closed by Windows when this launcher exits, not inherited by children.


def port_available(port):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(('127.0.0.1', port))
        return True
    except OSError:
        return False


def engine_ready(port, key, provider='gpt-sovits'):
    return verified_engine(build_opener(ProxyHandler({}), NoRedirect()), f'http://127.0.0.1:{port}', key, timeout=1, provider=provider)


def launch(command):
    return subprocess.Popen(command, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def stop_owned(process):
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8787)
    parser.add_argument('--voice-port', type=int, default=9880)
    parser.add_argument('--provider', choices=('auto', *PROVIDERS), default='auto')
    args = parser.parse_args()
    if any(not 1024 <= port <= 65535 for port in (args.port, args.voice_port)) or args.port == args.voice_port:
        raise RuntimeError('Choose two different local ports between 1024 and 65535.')
    settings_path = provider_settings_path(ROOT / '.studio-local', args.provider)
    try:
        settings = read_settings(settings_path)
    except (OSError, ValueError):
        raise RuntimeError('Run setup-pc-voice.cmd first. Browser TTS still works with start-studio.cmd.') from None
    if not Path(settings['python']).is_file():
        raise RuntimeError('The private Python environment is missing. Run setup-pc-voice.cmd again.')
    if not port_available(args.port):
        raise RuntimeError(f'Editor port {args.port} is already in use. Save your project before stopping the old server, or run start-pc-voice.cmd --port 8788.')
    provider = provider_of(settings)
    reuse_engine = engine_ready(args.voice_port, settings['engineKey'], provider)
    if not reuse_engine and not port_available(args.voice_port):
        raise RuntimeError('The voice port is occupied by a different engine. Stop that engine or choose --voice-port 9881.')
    owned_job = own_windows_process_tree()
    engine = editor = None
    try:
        if not reuse_engine:
            print('Loading the PC voice engine. The first start may take a few minutes...', flush=True)
            engine = launch([settings['python'], str(ROOT / 'pc_voice_engine.py'), '--settings', str(settings_path), '--port', str(args.voice_port)])
        editor = launch([sys.executable, str(ROOT / 'studio_server.py'), '--port', str(args.port), '--voice-port', str(args.voice_port), '--voice-provider', provider])
        print(f'Local editor: http://127.0.0.1:{args.port}/studio.html', flush=True)
        print('Keep this launcher open. Ctrl+C stops only the processes started here.', flush=True)
        ready = reuse_engine
        reported_failure = False
        while editor.poll() is None:
            if not ready and not reported_failure:
                if engine is not None and engine.poll() is not None:
                    reported_failure = True
                    error_type = ''
                    try:
                        status = json.loads((Path(settings['data']) / 'runtime-status.json').read_text())
                        error_type = status.get('errorType') or ''
                    except (OSError, ValueError):
                        pass
                    print('PC voice did not start' + (f' ({error_type})' if error_type else '') + '. Run setup again. Browser TTS and editing remain available.', flush=True)
                elif engine_ready(args.voice_port, settings['engineKey'], provider):
                    ready = True
                    print(PROVIDERS[provider][0] + ' is ready. In the editor: AI voice > PC extension > My voice.', flush=True)
            elif ready and engine is not None and engine.poll() is not None and not reported_failure:
                reported_failure = True
                print('PC voice stopped. Save your project and restart this launcher when ready. The editor remains open.', flush=True)
            time.sleep(1)
        raise RuntimeError('The local editor server stopped. Save work before restarting the launcher.')
    except KeyboardInterrupt:
        print('\nStopping this launcher...', flush=True)
    finally:
        stop_owned(editor)
        stop_owned(engine)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
