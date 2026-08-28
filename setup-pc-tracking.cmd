@echo off
setlocal
cd /d "%~dp0"
set "STUDIO_TRACKING_PY=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%STUDIO_TRACKING_PY%" (
  "%STUDIO_TRACKING_PY%" setup_pc_tracking.py %*
  goto done
)
where py >nul 2>nul
if not errorlevel 1 (
  py -3 setup_pc_tracking.py %*
  goto done
)
where python >nul 2>nul
if not errorlevel 1 (
  python setup_pc_tracking.py %*
  goto done
)
echo Python 3.10 or later is required to start the isolated setup.
:done
if not defined STUDIO_TRACKING_NO_PAUSE pause
