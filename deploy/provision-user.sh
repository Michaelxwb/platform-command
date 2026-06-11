#!/usr/bin/env bash
# CLI-01：开通用户隔离环境（FEAT-02）。
# 用法:
#   provision-user.sh <userId> [--im tui|wecom|dingtalk|tg] [--image <tag>] [--dir <实例目录>]
#   provision-user.sh <userId> --start [--dir <实例目录>] [--allow-public-im]
# --allow-public-im: 显式允许 allowed_users 为 ['*']/留空（机器人对全租户开放，
#   仅限演示/测试场景；该容器内的登录态与 LLM 配额将对所有能搜到机器人的人可用）
# 退出码: 0=成功 2=用户已存在 4=mykey 占位符未填
set -euo pipefail
cd "$(dirname "$0")"

USER_ID="${1:?用法: provision-user.sh <userId> [--im ...] [--image <tag>] [--dir <path>] [--start]}"
shift
IM="tui"
IMAGE="${MUAD_IMAGE:-muad:latest}"
TARGET_DIR=""
START=false
ALLOW_PUBLIC_IM=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --im)    IM="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --dir)   TARGET_DIR="$2"; shift 2 ;;
    --start) START=true; shift ;;
    --allow-public-im) ALLOW_PUBLIC_IM=true; shift ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done
TARGET_DIR="${TARGET_DIR:-$(pwd)/users/${USER_ID}}"

if ! [[ "${USER_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "FATAL: userId 格式无效: '${USER_ID}'" >&2
  exit 1
fi

# ── --start：校验 mykey 已填好后启动 ─────────────────────────────────────
if ${START}; then
  [[ -f "${TARGET_DIR}/compose.yml" ]] || { echo "FATAL: ${TARGET_DIR} 未开通，先不带 --start 跑一次" >&2; exit 1; }
  if grep -q 'FILL_' "${TARGET_DIR}/mykey.py"; then
    echo "FATAL: ${TARGET_DIR}/mykey.py 还有未填的占位符：" >&2
    grep -n 'FILL_' "${TARGET_DIR}/mykey.py" | sed 's/^/  /' >&2
    exit 4
  fi
  # IM 前端必须配齐渠道凭证 + allowed_users 身份绑定（禁止 ['*'] / 留空 / 模板占位）
  FRONTEND=$(grep '^GA_FRONTEND=' "${TARGET_DIR}/.env" | cut -d= -f2)
  case "${FRONTEND}" in
    wecom)    IM_VARS="wecom_bot_id wecom_secret wecom_allowed_users" ;;
    dingtalk) IM_VARS="dingtalk_client_id dingtalk_client_secret dingtalk_allowed_users" ;;
    tg)       IM_VARS="tg_bot_token tg_allowed_users" ;;
    *)        IM_VARS="" ;;
  esac
  for var in ${IM_VARS}; do
    line=$(grep -E "^${var}\s*=" "${TARGET_DIR}/mykey.py" || true)
    if [[ -z "${line}" ]]; then
      echo "FATAL: GA_FRONTEND=${FRONTEND} 需要在 mykey.py 配置 ${var}（取消注释并填值）" >&2
      exit 4
    fi
    if [[ "${var}" == *allowed_users* ]] && echo "${line}" | grep -qE "\*|<|\[\s*\]"; then
      if ${ALLOW_PUBLIC_IM}; then
        echo "⚠️  WARNING: ${var} 未限定到个人——该机器人对全租户开放（--allow-public-im 已显式确认）。" >&2
        echo "⚠️  此容器内的登录态、LLM 配额、执行能力对所有能给机器人发消息的人可用，测试结束后立即收紧。" >&2
      else
        echo "FATAL: ${var} 必须限定为该用户本人的账号，禁止 ['*'] / 留空 / 模板占位（身份绑定，NFR-SEC-01）。" >&2
        echo "       演示/测试场景确需开放，显式加 --allow-public-im。" >&2
        exit 4
      fi
    fi
  done
  docker compose -p "muad-${USER_ID}" -f "${TARGET_DIR}/compose.yml" up -d
  echo "已启动: muad-${USER_ID}"
  echo "  查看日志: docker logs muad-${USER_ID}"
  FE=$(grep '^GA_FRONTEND=' "${TARGET_DIR}/.env" | cut -d= -f2)
  [[ "${FE}" == "tui" ]] && echo "  进入 TUI: docker attach muad-${USER_ID}（Ctrl-P Ctrl-Q 退出不杀容器）"
  [[ "${FE}" == "wechat" ]] && echo "  微信扫码登录: docker logs -f muad-${USER_ID} 看二维码（ASCII），用该用户微信扫码绑定；token 持久化在 data volume"
  exit 0
fi

# ── 开通：生成实例目录 ───────────────────────────────────────────────────
if [[ -d "${TARGET_DIR}" ]]; then
  echo "用户已存在: ${TARGET_DIR}（启动用 --start；重建请先删除该目录与 volume）" >&2
  exit 2
fi
mkdir -p "${TARGET_DIR}"

export PC_USER="${USER_ID}" MUAD_IMAGE="${IMAGE}" COMMANDS_DIR="${COMMANDS_DIR:-$(pwd)/platform-commands}"
mkdir -p "${COMMANDS_DIR}"
envsubst '${PC_USER} ${MUAD_IMAGE} ${COMMANDS_DIR}' < compose.template.yml > "${TARGET_DIR}/compose.yml"

# 交互式前端需要 tty/stdin：tui 全程交互；wechat 首次扫码登录需 TTY 显示二维码
if [[ "${IM}" == "tui" || "${IM}" == "wechat" ]]; then
  awk '1; /restart: unless-stopped/{print "    stdin_open: true"; print "    tty: true"}' \
    "${TARGET_DIR}/compose.yml" > "${TARGET_DIR}/compose.yml.tmp" && mv "${TARGET_DIR}/compose.yml.tmp" "${TARGET_DIR}/compose.yml"
fi

sed "s/^GA_FRONTEND=.*/GA_FRONTEND=${IM}/" env.template > "${TARGET_DIR}/.env"
cp mykey.minimal.py "${TARGET_DIR}/mykey.py"
chmod 600 "${TARGET_DIR}/.env" "${TARGET_DIR}/mykey.py"

echo "已生成: ${TARGET_DIR}（image=${IMAGE}, frontend=${IM}）"
echo ""
echo "管理员只需两步："
echo "  1. 编辑 ${TARGET_DIR}/mykey.py —— 填 3 个 FILL_ 占位符（IM 渠道另按注释填凭证+allowed_users）"
echo "  2. $0 ${USER_ID} --start$([[ -n "${2:-}" ]] || true)${TARGET_DIR:+ --dir ${TARGET_DIR}}"
echo ""
echo "浏览器命令需要时再导入登录态: ./import-storage-state.sh ${USER_ID} <platform-host> <storageState.json>"