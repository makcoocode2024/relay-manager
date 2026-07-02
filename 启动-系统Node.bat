@echo off
title RelayManager System Node
cd /d "%~dp0"

echo ============================================
echo   RelayManager - System Node Edition
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo System Node.js was not found in PATH.
    echo Please install Node.js first, then run this file again.
    echo.
    pause
    exit /b 1
)

echo Starting server with system Node.js...
echo URL: http://localhost:9876
echo.
echo Close this window to stop the service
echo --------------------------------------------
echo.

start "" http://localhost:9876

node server.js

pause
