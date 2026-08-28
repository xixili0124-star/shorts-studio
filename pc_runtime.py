"""설치된 PC 음성 엔진을 찾고, 이 실행기가 시작한 프로세스만 관리합니다."""
import os
from contextlib import ExitStack
from pathlib import Path
import socket
import subprocess
import threading
import time

from pc_asr import stop_process
from pc_asr_process import WindowsJob
from pc_voice import VoiceError, verified_engine
from pc_voice_config import provider_of, settings_path
from pc_voice_engine import read_settings

ROOT = Path(__file__).resolve().parent
# Windows 루프백 포트도 명시적 연결 거절을 받기까지 약 2초 걸릴 수 있다.
SHUTDOWN_PROBE_TIMEOUT = 4


class PcVoiceRuntime:
    def __init__(self, local, service, port=9880, provider='auto'):
        self.local, self.service = Path(local), service
        self.port, self.provider = port, provider
        self.process = self.job = None
        self.guard = threading.RLock()
        self.next_attempt = 0
        self.message = ''
        self.stopping = False
        self.closed = False
        self._shutdown_lease = None
        self._gate_held = False

    def _dispose_owned(self):
        """작업 객체 실패와 무관하게 직접 만든 리디렉터도 정리한다."""
        owned = self.job is not None or self.process is not None
        failed = False
        if self.job is not None:
            try:
                self.job.close()
            except Exception:
                failed = True
        if self.process is not None:
            try:
                stop_process(self.process)
            except Exception:
                failed = True
        if failed:
            self.service.uncertain = True
            self.message = 'PC 음성 프로세스의 종료를 확인하지 못했습니다. PC 실행기를 완전히 종료해 주세요.'
            raise OSError('PC voice process cleanup was not confirmed.')
        self.process = self.job = None
        return owned

    def ensure_running(self):
        with self.guard:
            if self.closed or self.stopping or self.service.closed:
                return False
            try:
                path = settings_path(self.local, self.provider)
                settings = read_settings(path)
                if not Path(settings['python']).is_file():
                    raise ValueError()
            except (OSError, ValueError, RuntimeError):
                self.message = 'PC 음성 설치가 필요합니다. 도움말의 PC 설치에서 준비해 주세요.'
                return False
            if not self.service.lock.acquire(blocking=False):
                return True
            try:
                if self.service.uncertain:
                    return True
                # 설치 완료 후 같은 서버의 음성·자막·추적 서비스가 동일한 키와 락을 사용합니다.
                self.service.provider = provider_of(settings)
                self.service.engine_headers = {'X-Studio-Engine-Key': settings['engineKey']}
                if verified_engine(self.service.opener, self.service.endpoint, settings['engineKey'],
                                   timeout=1, provider=self.service.provider):
                    self.message = ''
                    return True
                if self.process is not None:
                    if self.process.poll() is None:
                        self.message = '설치된 PC 음성 엔진을 시작하고 있어요. 잠시 후 자동으로 연결됩니다.'
                        return True
                    self._dispose_owned()
                    self.next_attempt = time.monotonic() + 30
                    self.message = '음성 엔진이 시작되지 않았습니다. 도움말에서 설치 확인을 다시 눌러 주세요.'
                    return True
                if time.monotonic() < self.next_attempt:
                    return True
                try:
                    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                        probe.bind(('127.0.0.1', self.port))
                except OSError:
                    self.message = '다른 엔진이 음성 연결 포트를 사용 중입니다. 기존 PC 실행기를 종료한 뒤 설치 확인을 눌러 주세요.'
                    return True
                job = WindowsJob()
                arguments = [settings['python'], str(ROOT / 'pc_voice_engine.py'), '--settings', str(path), '--port', str(self.port)]
                if job.name:
                    arguments.extend(['--job-name', job.name])
                environment = os.environ.copy()
                for name in ('OPENAI_API_KEY', 'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'ANTHROPIC_API_KEY'):
                    environment.pop(name, None)
                self.job = job
                try:
                    process = subprocess.Popen(arguments, cwd=ROOT, env=environment,
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                except OSError:
                    self._dispose_owned()
                    raise
                self.job, self.process = job, process
                self.message = '설치된 PC 음성 엔진을 시작하고 있어요. 잠시 후 자동으로 연결됩니다.'
                return True
            except OSError:
                self.next_attempt = time.monotonic() + 30
                if not self.service.uncertain:
                    self.message = 'PC 음성 실행 환경을 시작하지 못했습니다. 도움말에서 설치를 확인해 주세요.'
                return True
            finally:
                self.service.lock.release()

    def status(self):
        configured = self.ensure_running()
        status = self.service.status()
        if status['state'] == 'offline' and self.message:
            status['message'] = self.message
            if configured and self.process is not None and self.process.poll() is None:
                status['state'] = 'starting'
        return {**status, 'configured': configured}

    def prepare_shutdown(self, asr, tracking):
        """새 작업을 막고 다른 서버의 엔진 작업까지 확인한 뒤 종료를 승인한다."""
        with self.guard:
            if self.closed or self.stopping or self.service.closed:
                raise VoiceError('PC_STOPPING', 'PC 연결 프로그램이 이미 종료 중입니다.', 503)
            if self.service.uncertain:
                raise VoiceError('ENGINE_RESTART_REQUIRED', '이전 PC 작업의 종료를 확인하지 못했습니다. 실행기를 완전히 종료해 주세요.', 503)
            if not self.service.lock.acquire(blocking=False):
                raise VoiceError('PC_BUSY', '진행 중인 PC 작업을 완료하거나 취소한 뒤 다시 실행해 주세요.', 409)
            prepared = False
            try:
                # 작업 시작은 각 서비스 락 안에서 공유 음성 락을 확인한다.
                # 같은 순서로 작업을 닫으면 이미 HTTP 본문을 읽는 요청도 진입하지 못한다.
                with ExitStack() as locks:
                    for worker in (asr, tracking):
                        locks.enter_context(worker.lock)
                    if any(worker.active for worker in (asr, tracking)):
                        raise VoiceError('PC_BUSY', '진행 중인 PC 작업을 완료하거나 취소한 뒤 다시 실행해 주세요.', 409)
                    if any(worker.uncertain for worker in (asr, tracking)):
                        raise VoiceError('ENGINE_RESTART_REQUIRED', 'PC 작업의 종료를 확인하지 못했습니다. 실행기를 완전히 종료해 주세요.', 503)
                    key = self.service.engine_headers.get('X-Studio-Engine-Key')
                    offline_without_owned_process = False
                    if key and self.process is None and self.job is None:
                        ready = verified_engine(self.service.opener, self.service.endpoint, key,
                                                timeout=SHUTDOWN_PROBE_TIMEOUT,
                                                provider=self.service.provider, allow_offline=True)
                        if ready is False:
                            raise VoiceError('ENGINE_NOT_READY', '공유 PC 엔진의 신원을 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.', 503)
                        # 소유한 프로세스가 전혀 없고 연결 거절인 경우에만 서버 단독 종료를 허용한다.
                        offline_without_owned_process = ready is None
                    # 동일 엔진을 사용하는 다른 서버의 TTS·자막·추적도 이 예약으로 보호한다.
                    self._shutdown_lease = (None if offline_without_owned_process else
                                            self.service.reserve_asr(required_free_mib=3200, ttl=120))
                    self.stopping = True
                    self.service.closed = True
                    for worker in (asr, tracking):
                        worker.closed = True
                    self._gate_held = True
                    prepared = True
            finally:
                if not prepared:
                    self.service.lock.release()

    def close(self):
        with self.guard:
            if self.closed and self.job is None and self.process is None and not self._shutdown_lease:
                return
            self.closed = self.stopping = True
            self.service.closed = True
            owned = self._dispose_owned()
            if self._shutdown_lease is not None:
                try:
                    # 빌려 쓴 엔진은 살려 두며, 우리 예약만 해제한다.
                    # 소유 엔진 종료 후 다른 엔진이 포트를 이어받은 경우도 확인한다.
                    offline = owned and verified_engine(
                        self.service.opener, self.service.endpoint,
                        self.service.engine_headers.get('X-Studio-Engine-Key'),
                        timeout=SHUTDOWN_PROBE_TIMEOUT,
                        provider=self.service.provider, allow_offline=True) is None
                    if not offline:
                        self.service.release_asr(self._shutdown_lease['token'])
                    self._shutdown_lease = None
                except Exception:
                    self.service.uncertain = True
                    raise OSError('PC engine shutdown reservation release was not confirmed.') from None
            if self._gate_held:
                self.service.lock.release()
                self._gate_held = False
