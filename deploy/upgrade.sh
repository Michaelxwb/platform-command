#!/usr/bin/env bash
# CLI-04：滚动升级用户容器（§4.2）。volume 不动，回滚 = 指定旧 tag 重跑。
# 用法: upgrade.sh --tag <镜像tag> (--users a,b | --all)
set -euo pipefail
cd "$(dirname "$0")"

TAG=""
USERS=""
ALL=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)   TAG="$2"; shift 2 ;;
    --users) USERS="$2"; shift 2 ;;
    --all)   ALL=true; shift ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done
[[ -n "${TAG}" ]] || { echo "FATAL: 必须指定 --tag" >&2; exit 1; }

if ${ALL}; then
  # --all 前置检查：该 tag 必须已有试点容器在跑（§4.2 灰度门槛）
  if ! docker ps --filter "ancestor=${TAG}" --format '{{.Names}}' | grep -q '^muad-'; then
    echo "FATAL: tag ${TAG} 尚无运行中的试点容器，先 --users <试点> 灰度" >&2
    exit 1
  fi
  USERS=$(ls users/ 2>/dev/null | tr '\n' ',' | sed 's/,$//')
fi
[[ -n "${USERS}" ]] || { echo "FATAL: 没有可升级的用户（--users 或 --all）" >&2; exit 1; }

IFS=',' read -ra USER_LIST <<< "${USERS}"
for user in "${USER_LIST[@]}"; do
  user_dir="users/${user}"
  [[ -d "${user_dir}" ]] || { echo "跳过 ${user}: 未开通" >&2; continue; }
  echo "[upgrade] ${user} → ${TAG}"
  MUAD_IMAGE="${TAG}" PC_USER="${user}" COMMANDS_DIR="${COMMANDS_DIR:-$(pwd)/platform-commands}" \
    envsubst '${PC_USER} ${MUAD_IMAGE} ${COMMANDS_DIR}' < compose.template.yml > "${user_dir}/compose.yml"
  docker compose -p "muad-${user}" -f "${user_dir}/compose.yml" up -d
done
echo "[upgrade] 完成: ${USERS}"
