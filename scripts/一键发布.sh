#!/usr/bin/env bash

set -u

PROJECT_DIR="/home/zhuxi/AI价格比对工具"
cd "$PROJECT_DIR" || {
  echo "无法进入项目目录：$PROJECT_DIR"
  exit 1
}

printf '\nAI 价格比对 - 一键发布\n'
printf '========================\n\n'

publish_github_pages() {
  printf '\n正在发布 GitHub Pages……\n'
  git add -- index.html || return 1

  if git diff --cached --quiet -- index.html; then
    echo "GitHub Pages 数据没有变化，跳过提交。"
  else
    git commit -m "Update published price data" -- index.html || return 1
  fi

  git push origin main || return 1
  echo "GitHub Pages 发布成功：https://zhuxi99.github.io/ai-price-compare.github.io/"
}

prepare_only=false
if [[ "${1:-}" == "--prepare-only" ]]; then
  prepare_only=true
  npm run deploy:prepare
else
  npm run deploy:data
fi
status=$?

if [[ $status -eq 0 && $prepare_only == false ]]; then
  publish_github_pages
  status=$?
fi

printf '\n'
if [[ $status -eq 0 ]]; then
  if [[ $prepare_only == true ]]; then
    echo "检查成功，未执行线上发布。"
  else
    echo "Surge 发布成功：https://ai-price-compare.surge.sh"
    echo "全部发布完成。"
  fi
else
  echo "发布失败，请查看上面的错误信息。"
fi

if [[ -t 0 ]]; then
  printf '\n'
  read -r -p "按回车键关闭窗口……" _
fi

exit "$status"
