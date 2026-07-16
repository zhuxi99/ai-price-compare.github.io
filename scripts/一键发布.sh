#!/usr/bin/env bash

set -u

PROJECT_DIR="/home/zhuxi/AI价格比对工具"
cd "$PROJECT_DIR" || {
  echo "无法进入项目目录：$PROJECT_DIR"
  exit 1
}

printf '\nAI 价格比对 - 一键发布\n'
printf '========================\n\n'

push_github_with_retry() {
  local max_attempts="${GITHUB_PUSH_MAX_ATTEMPTS:-3}"
  local retry_delay="${GITHUB_PUSH_RETRY_DELAY:-5}"
  local push_timeout="${GITHUB_PUSH_TIMEOUT:-45}"
  local log_file="${PUBLISH_LOG_FILE:-$PROJECT_DIR/一键发布.log}"
  local attempt push_status

  for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
    printf '\n[%(%F %T)T] GitHub push，第 %d/%d 次\n' -1 "$attempt" "$max_attempts" | tee -a "$log_file"
    timeout --signal=TERM "$push_timeout" git push origin main 2>&1 | tee -a "$log_file"
    push_status=${PIPESTATUS[0]}
    if [[ $push_status -eq 0 ]]; then
      return 0
    fi
    if [[ $push_status -eq 124 ]]; then
      echo "第 ${attempt} 次推送超过 ${push_timeout} 秒，已终止本次连接。" | tee -a "$log_file"
    fi
    if [[ $attempt -lt $max_attempts ]]; then
      echo "第 ${attempt} 次推送失败，${retry_delay} 秒后重试……"
      sleep "$retry_delay"
    fi
  done

  echo "GitHub 推送连续失败，详细日志：$log_file"
  return 1
}

publish_github_pages() {
  printf '\n正在发布 GitHub Pages……\n'
  git add -- index.html background.webm || return 1

  if git diff --cached --quiet -- index.html background.webm; then
    echo "GitHub Pages 页面和视频没有变化，跳过提交。"
  else
    git commit -m "Update published site" -- index.html background.webm || return 1
  fi

  push_github_with_retry || return 1
  echo "GitHub Pages 发布成功：https://zhuxi99.github.io/ai-price-compare.github.io/"
}

prepare_only=false
if [[ "${1:-}" == "--prepare-only" ]]; then
  prepare_only=true
  if [[ -n "${2:-}" ]]; then
    npm run deploy:prepare -- "$2"
  else
    npm run deploy:prepare
  fi
elif [[ -n "${1:-}" ]]; then
  npm run deploy:data -- "$1"
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
