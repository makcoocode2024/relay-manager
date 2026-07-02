@echo off
title Build RelayManager Portable
cd /d "%~dp0"

echo ============================================
echo   RelayManager - Build Portable Package
echo ============================================
echo.

set "NODE_EXE=%~dp0runtime\node\node.exe"
set "NPM_CMD=%~dp0runtime\node\npm.cmd"

if not exist "%NODE_EXE%" (
    echo Portable Node runtime not found.
    echo Missing: %NODE_EXE%
    echo.
    pause
    exit /b 1
)

if not exist "%NPM_CMD%" (
    echo Portable npm command not found.
    echo Missing: %NPM_CMD%
    echo.
    pause
    exit /b 1
)

echo Step 1/2: running portable check...
call "%NPM_CMD%" run portable:check
if errorlevel 1 (
    echo.
    echo Portable check failed. Zip package was not generated.
    pause
    exit /b 1
)

echo.
echo Step 2/2: building RelayManager-Portable.zip...
"%NODE_EXE%" scripts\build-portable.js portable
if errorlevel 1 (
    echo.
    echo Build failed.
    pause
    exit /b 1
)

echo.
echo Done: RelayManager-Portable.zip
pause
