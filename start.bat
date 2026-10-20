@echo off
title OmniCast - AnyDesk Remote Desktop
cd /d "%~dp0"

echo ==========================================================
echo        OmniCast - Ultra-Fast WebRTC Remote Desktop
echo ==========================================================
echo.
echo [*] Checking Node.js environment...

set NODE_CMD=node
if exist "C:\Program Files\nodejs\node.exe" (
    set NODE_CMD="C:\Program Files\nodejs\node.exe"
)

echo [*] Launching OmniCast server with Windows OS Controller...
start "" http://localhost:3000

%NODE_CMD% server.js
if %errorlevel% neq 0 (
    echo.
    echo [!] Server exited or failed to start.
    pause
)
