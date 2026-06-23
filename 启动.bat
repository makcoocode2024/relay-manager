@echo off
title RelayManager - 中转站配置工具

cd /d "%~dp0"

echo ============================================
echo   RelayManager 中转站配置工具
echo ============================================
echo.
echo 正在启动服务...
echo 浏览器请访问: http://localhost:9876
echo.
echo 关闭此窗口即可停止服务
echo --------------------------------------------
echo.

start "" http://localhost:9876

node server.js

pause
