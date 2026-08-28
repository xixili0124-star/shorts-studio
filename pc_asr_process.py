"""한 ASR 작업에서 직접 시작한 Windows 프로세스만 함께 정리한다."""

import ctypes
import math
import os
import re
import threading
import time
import uuid


_JOB_NAME = re.compile(r'Local\\ShortsStudioASR-[a-f0-9]{32}\Z')
_KILL_ON_JOB_CLOSE = 0x2000
_ACTIVE_PROCESS_LIMIT = 0x0008
_JOB_OBJECT_ASSIGN_PROCESS = 0x0001


class ProcessJobError(OSError):
    """프로세스 정리의 성공을 확인하지 못했을 때 발생하는 안전한 오류."""


class _BasicLimits(ctypes.Structure):
    _fields_ = [
        ('PerProcessUserTimeLimit', ctypes.c_int64),
        ('PerJobUserTimeLimit', ctypes.c_int64),
        ('LimitFlags', ctypes.c_uint32),
        ('MinimumWorkingSetSize', ctypes.c_size_t),
        ('MaximumWorkingSetSize', ctypes.c_size_t),
        ('ActiveProcessLimit', ctypes.c_uint32),
        ('Affinity', ctypes.c_size_t),
        ('PriorityClass', ctypes.c_uint32),
        ('SchedulingClass', ctypes.c_uint32),
    ]


class _IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in (
        'ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount',
        'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]


class _ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ('BasicLimitInformation', _BasicLimits), ('IoInfo', _IoCounters),
        ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
        ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t),
    ]


class _BasicAccounting(ctypes.Structure):
    _fields_ = [
        ('TotalUserTime', ctypes.c_int64), ('TotalKernelTime', ctypes.c_int64),
        ('ThisPeriodTotalUserTime', ctypes.c_int64), ('ThisPeriodTotalKernelTime', ctypes.c_int64),
        ('TotalPageFaultCount', ctypes.c_uint32), ('TotalProcesses', ctypes.c_uint32),
        ('ActiveProcesses', ctypes.c_uint32), ('TotalTerminatedProcesses', ctypes.c_uint32),
    ]


def _kernel32():
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    definitions = {
        'CreateJobObjectW': ([ctypes.c_void_p, ctypes.c_wchar_p], ctypes.c_void_p),
        'OpenJobObjectW': ([ctypes.c_uint32, ctypes.c_int, ctypes.c_wchar_p], ctypes.c_void_p),
        'SetInformationJobObject': ([ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32], ctypes.c_int),
        'QueryInformationJobObject': ([ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p,
                                       ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32)], ctypes.c_int),
        'AssignProcessToJobObject': ([ctypes.c_void_p, ctypes.c_void_p], ctypes.c_int),
        'TerminateJobObject': ([ctypes.c_void_p, ctypes.c_uint32], ctypes.c_int),
        'GetCurrentProcess': ([], ctypes.c_void_p),
        'CloseHandle': ([ctypes.c_void_p], ctypes.c_int),
    }
    for name, (arguments, result) in definitions.items():
        function = getattr(kernel, name)
        function.argtypes, function.restype = arguments, result
    return kernel


def _job_error(message):
    return ProcessJobError(f'{message} (Windows error {ctypes.get_last_error()}).')


class WindowsJob:
    """부모만 작업 핸들을 보관하고 실제 워커가 자신의 프로세스를 등록한다."""

    def __init__(self):
        self.name = None
        self._handle = None
        self._kernel = None
        self._cleanup_uncertain = False
        self._sealed = False
        self._lock = threading.RLock()
        if os.name != 'nt':
            return
        self._kernel = _kernel32()
        name = r'Local\ShortsStudioASR-' + uuid.uuid4().hex
        ctypes.set_last_error(0)
        handle = self._kernel.CreateJobObjectW(None, name)
        if not handle:
            raise _job_error('Cannot create the ASR process job')
        if ctypes.get_last_error() == 183:
            # 이름이 우연히 겹쳐도 기존 사용자의 작업 객체를 수정하지 않는다.
            self._kernel.CloseHandle(handle)
            raise ProcessJobError('The ASR process job already exists.')
        limits = _ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = _KILL_ON_JOB_CLOSE
        if not self._kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            error = _job_error('Cannot configure the ASR process job')
            self._kernel.CloseHandle(handle)
            raise error
        # SECURITY_ATTRIBUTES=None이므로 이 핸들은 자식에게 상속되지 않는다.
        self.name, self._handle = name, handle

    def active_processes(self):
        with self._lock:
            if self._handle is None:
                if self._cleanup_uncertain:
                    raise ProcessJobError('ASR process job termination was not confirmed.')
                return 0
            accounting = _BasicAccounting()
            if not self._kernel.QueryInformationJobObject(
                    self._handle, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None):
                raise _job_error('Cannot query the ASR process job')
            return int(accounting.ActiveProcesses)

    def _seal(self):
        if self._sealed:
            return
        # TerminateJobObject만으로는 나중에 도착한 워커의 가입을 막지 못한다.
        limits = _ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = _KILL_ON_JOB_CLOSE | _ACTIVE_PROCESS_LIMIT
        limits.BasicLimitInformation.ActiveProcessLimit = 0
        if not self._kernel.SetInformationJobObject(
                self._handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise _job_error('Cannot seal the ASR process job')
        self._sealed = True

    def terminate(self, timeout=10):
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= 30:
            raise ValueError('Invalid ASR process cleanup timeout.')
        with self._lock:
            if self._handle is None:
                if self._cleanup_uncertain:
                    raise ProcessJobError('ASR process job termination was not confirmed.')
                return True
            self._seal()
            if not self._kernel.TerminateJobObject(self._handle, 1):
                raise _job_error('Cannot terminate the ASR process job')
            deadline = time.monotonic() + timeout
            # Popen의 리디렉터 종료와 별개로 실제 워커·후손의 종료를 확인한다.
            while self.active_processes():
                if time.monotonic() >= deadline:
                    raise ProcessJobError('ASR process job termination was not confirmed.')
                time.sleep(0.05)
            return True

    def close(self, timeout=10):
        with self._lock:
            if self._handle is None:
                if self._cleanup_uncertain:
                    raise ProcessJobError('ASR process job termination was not confirmed.')
                return True
            try:
                self._seal()
                if self.active_processes():
                    self.terminate(timeout)
            except BaseException:
                self._cleanup_uncertain = True
                raise
            finally:
                # 확인 실패 때도 핸들을 닫아 종료를 요청하되, 실패는 호출자에게 남긴다.
                handle = self._handle
                if not self._kernel.CloseHandle(handle):
                    self._cleanup_uncertain = True
                    raise _job_error('Cannot close the ASR process job')
                self._handle = None
            return True

    @staticmethod
    def join_current(name):
        if os.name != 'nt':
            return True
        if not isinstance(name, str) or not _JOB_NAME.fullmatch(name):
            raise ProcessJobError('Invalid ASR process job name.')
        kernel = _kernel32()
        handle = kernel.OpenJobObjectW(_JOB_OBJECT_ASSIGN_PROCESS, False, name)
        if not handle:
            raise _job_error('Cannot open the ASR process job')
        try:
            if not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
                raise _job_error('Cannot join the ASR process job')
        finally:
            # 워커가 핸들을 보유하면 부모 종료 시 KILL_ON_JOB_CLOSE가 작동하지 않는다.
            if not kernel.CloseHandle(handle):
                raise _job_error('Cannot close the ASR worker job handle')
        return True
