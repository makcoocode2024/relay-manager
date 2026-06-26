@echo off
title Stop RelayManager

echo ============================================
echo   Stop RelayManager Service
echo ============================================
echo.

echo Searching for node process on port 9876...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":9876 " ^| findstr "LISTENING"') do (
    echo Found PID: %%a
    taskkill /f /pid %%a >/dev/null 2>&1
    echo Stopped process %%a
)

echo.
echo --------------------------------------------
echo If not fully stopped, close the running cmd window manually
echo --------------------------------------------
pause
