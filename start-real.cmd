@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-real.ps1" %*
set "JARVIS_EXIT_CODE=%ERRORLEVEL%"
if not "%JARVIS_EXIT_CODE%"=="0" (
    echo.
    pause
)
exit /b %JARVIS_EXIT_CODE%
