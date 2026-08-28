@echo off
setlocal
cd /d "%~dp0"
echo Shorts Studio LAB - http://127.0.0.1:8787/studio.html
echo Keep this window open while editing. Press Ctrl+C to stop.
set "STUDIO_PY=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%STUDIO_PY%" (
  "%STUDIO_PY%" studio_server.py --port 8787
  goto done
)
where py >nul 2>nul
if not errorlevel 1 (
  py -3 studio_server.py --port 8787
  goto done
)
where python >nul 2>nul
if not errorlevel 1 (
  python studio_server.py --port 8787
  goto done
)
echo Python 3.10 or later is required. Please install Python first.
:done
pause
