#!/usr/bin/env bash
# CLI-02：导入用户登录态（FEAT-04）。校验 JSON → 原子落盘 → 清除失效标记。
# 用法: import-storage-state.sh <userId> <platform-host> <storageState.json>
# 退出码: 0=成功 3=文件非法
# 注: v1 约定单一合并 storageState（cookies 自带 domain，多平台可共存一份）；
#     <platform-host> 用于清除对应主机的会话失效标记。
set -euo pipefail
cd "$(dirname "$0")"

USER_ID="${1:?用法: import-storage-state.sh <userId> <platform-host> <file>}"
PLATFORM_HOST="${2:?缺少 platform-host（如 api.example.com）}"
STATE_FILE="${3:?缺少 storageState 文件路径}"
CONTAINER="muad-${USER_ID}"

# 结构校验（RISK-B：先校验再落盘）
if ! node -e '
  const fs = require("fs");
  const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(parsed.cookies)) throw new Error("missing cookies array");
' "${STATE_FILE}"; then
  echo "FATAL: storageState 文件非法（需为 Playwright storageState JSON，含 cookies 数组）" >&2
  exit 3
fi

# 原子落盘：先写临时文件再 rename（容器内同一 volume，rename 原子）
TARGET=/secrets/storage-state/default.storageState.json
docker cp "${STATE_FILE}" "${CONTAINER}:${TARGET}.importing"
docker exec "${CONTAINER}" sh -c "mv '${TARGET}.importing' '${TARGET}' && chmod 600 '${TARGET}'"

# 清除该主机的会话失效标记（FEAT-05 → 下次执行直接可用）
SAFE_HOST=$(echo "${PLATFORM_HOST}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9.-]/_/g')
docker exec "${CONTAINER}" sh -c "rm -f '/data/platform/.platform-command/sessions/${SAFE_HOST}.json'"

echo "已导入 ${USER_ID} 的登录态（${PLATFORM_HOST}），适配器将在下次执行时自动加载新状态"
