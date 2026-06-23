#!/usr/bin/env bash
# RelayManager 启动脚本 (macOS / Linux)
# 后台静默启动，日志写入 server.log。
cd "$(dirname "$0")"
if pgrep -f "node .*server.js" >/dev/null 2>&1; then
  echo "RelayManager 似乎已在运行。先运行 ./stop.sh 再启动。"
  exit 1
fi
nohup node server.js > server.log 2>&1 &
echo "RelayManager 已启动，访问 http://localhost:9876"
echo "日志: $(pwd)/server.log ｜ 停止: ./stop.sh"
