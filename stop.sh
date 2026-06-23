#!/usr/bin/env bash
# RelayManager 停止脚本 (macOS / Linux)
pkill -f "node .*server.js" && echo "RelayManager 已停止。" || echo "未发现运行中的 RelayManager。"
