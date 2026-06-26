@echo off
title RelayManager
cd /d "%~dp0"

echo ============================================
echo   RelayManager - Relay Config Tool
echo ============================================
echo.
echo Starting server...
echo URL: http://localhost:9876
echo.
echo Close this window to stop the service
echo --------------------------------------------
echo.

start "" http://localhost:9876

node server.js

pause
