@echo off
title RelayManager
cd /d "%~dp0"

echo ============================================
echo   RelayManager - Relay Config Tool
echo ============================================
echo.
set "NODE_EXE=%~dp0runtime\node\node.exe"

if not exist "%NODE_EXE%" (
    echo Portable Node runtime not found.
    echo Missing: %NODE_EXE%
    echo.
    echo Please put the portable Node.js files under:
    echo   runtime\node\
    echo.
    echo Expected file:
    echo   runtime\node\node.exe
    echo.
    pause
    exit /b 1
)

echo Starting server with portable Node...
echo URL: http://localhost:9876
echo.
echo Close this window to stop the service
echo --------------------------------------------
echo.

start "" http://localhost:9876

"%NODE_EXE%" server.js

pause
