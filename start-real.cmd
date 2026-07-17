@echo off
setlocal
set "JARVIS_DESKTOP=%~dp0desktop"
set "JARVIS_ELECTRON=%JARVIS_DESKTOP%\node_modules\electron\dist\electron.exe"

if not exist "%JARVIS_ELECTRON%" (
    echo AI Jarvis desktop dependencies are missing.
    echo Run "npm install" in "%JARVIS_DESKTOP%" and try again.
    pause
    exit /b 1
)

start "AI Jarvis" /D "%JARVIS_DESKTOP%" "%JARVIS_ELECTRON%" "%JARVIS_DESKTOP%"
exit /b 0
