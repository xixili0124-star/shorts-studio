@echo off
setlocal
cd /d "%~dp0"
set "STUDIO_PY=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%STUDIO_PY%" (
  "%STUDIO_PY%" start_pc_voice.py %*
  goto done
)
where py >nul 2>nul
if not errorlevel 1 (
  py -3 start_pc_voice.py %*
  goto done
)
where python >nul 2>nul
if not errorlevel 1 (
  python start_pc_voice.py %*
  goto done
)
echo Python 3.10 or later is required. Run setup-pc-voice.cmd first.
:done
pause
