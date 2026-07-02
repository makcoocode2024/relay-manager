@echo off
title Build RelayManager System Node Package
cd /d "%~dp0"

echo ============================================
echo   RelayManager - Build System Node Package
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

where npm >nul 2>nul
if errorlevel 1 (
    echo System npm was not found in PATH.
    echo Please install Node.js with npm first, then run this file again.
    echo.
    pause
    exit /b 1
)

echo Step 1/2: running portable check...
call npm run portable:check
if errorlevel 1 (
    echo.
    echo Portable check failed. Zip package was not generated.
    pause
    exit /b 1
)

echo.
echo Step 2/2: building RelayManager-SystemNode.zip...
node scripts\build-portable.js system
if errorlevel 1 (
    echo.
    echo Build failed.
    pause
    exit /b 1
)

echo.
echo Done: RelayManager-SystemNode.zip
pause
