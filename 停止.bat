@echo off
title 停止 RelayManager

echo ============================================
echo   停止 RelayManager 服务
echo ============================================
echo.

echo 正在查找并停止 node 服务进程...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":9876 " ^| findstr "LISTENING"') do (
    echo 找到服务进程 PID: %%a
    taskkill /f /pid %%a >nul 2>&1
    echo 已停止进程 %%a
)

echo.
echo --------------------------------------------
echo 如未完全停止，可手动关闭运行服务的命令行窗口
echo --------------------------------------------
pause
