#!/usr/bin/env bash

set -u

PROJECT_DIR="/home/zhuxi/AI价格比对工具"
cd "$PROJECT_DIR" || {
  echo "无法进入项目目录：$PROJECT_DIR"
  exit 1
}

printf '\nAI 价格比对 - 本地倍率抓取工具\n'
printf '================================\n\n'

node scripts/ratio-fetch-server.mjs --open
status=$?

if [[ $status -ne 0 ]]; then
  printf '\n工具异常退出。\n'
  if [[ -t 0 ]]; then
    read -r -p "按回车键关闭窗口……" _
  fi
fi

exit "$status"
