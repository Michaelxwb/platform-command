#!/usr/bin/env bash
# pc-exec —— 给 GA（及任何调用方）的"防呆"平台命令执行包装。
# 目的：把 platform-command 容易拼错的标志（--execute-real --confirm / 默认 dry-run）
# 藏进脚本，调用方只需给命令名 + 裸 key=value 参数，拼不错。
#
# 用法：
#   pc-exec <command> [key=value ...]            # 真实执行（自动加 --execute-real --confirm）
#   pc-exec --dry <command> [key=value ...]      # 仅预演（dry-run）
#   pc-exec --help
#
# 规则（与 platform-command 一致）：
#   · 参数一律 key=value，不加 --，不要 --param/--json
#   · 真实执行由本脚本自动补 --execute-real --confirm，调用方无需关心
set -euo pipefail

if [[ "${1:-}" == "--help" || $# -eq 0 ]]; then
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

DRY=false
if [[ "${1:-}" == "--dry" ]]; then DRY=true; shift; fi

COMMAND="${1:?用法: pc-exec <command> [key=value ...]（真实执行）或 pc-exec --dry <command> ...（预演）}"
shift

# 剩余参数必须是 key=value；挡掉常见误用（-- 前缀 / 编造的标志）
for arg in "$@"; do
  case "$arg" in
    --*) echo "pc-exec: 参数不要加 '--'（错误: $arg）。用 key=value，例如 resourceId=123" >&2; exit 2 ;;
    *=*) : ;;
    *) echo "pc-exec: 参数必须是 key=value（错误: $arg）" >&2; exit 2 ;;
  esac
done

if ${DRY}; then
  exec platform-command execute --command "$COMMAND" --dry-run "$@"
else
  exec platform-command execute --command "$COMMAND" --execute-real --confirm "$@"
fi
