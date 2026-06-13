#!/usr/bin/env bash
# 容器入口：校验服务器模式 env 与 mykey.py，持久化 GA 状态目录，启动所选前端。
set -euo pipefail

if [[ -z "${PLATFORM_COMMAND_USER_ID:-}" ]]; then
  echo "[muad] FATAL: PLATFORM_COMMAND_USER_ID 未设置（服务器模式必填）" >&2
  exit 1
fi

GA_DIR=/opt/generic-agent
if [[ ! -f "${GA_DIR}/mykey.py" ]]; then
  echo "[muad] FATAL: ${GA_DIR}/mykey.py 不存在。" >&2
  echo "[muad] 管理员需在 deploy/users/<userId>/mykey.py 填好 LLM 与 IM 凭证（含 *_allowed_users 绑定），由 compose 挂载。" >&2
  exit 1
fi

# GA 状态目录持久化：memory/skills/temp 落到 /data/ga volume，
# 首次启动时把仓库自带的种子内容（内置 SOP 等）拷贝过去。
mkdir -p /data/platform/output /data/ga
for state_dir in memory skills temp sche_tasks; do
  if [[ ! -d "/data/ga/${state_dir}" ]]; then
    if [[ -d "${GA_DIR}/${state_dir}" && ! -L "${GA_DIR}/${state_dir}" ]]; then
      cp -r "${GA_DIR}/${state_dir}" "/data/ga/${state_dir}"
    else
      mkdir -p "/data/ga/${state_dir}"
    fi
  fi
  rm -rf "${GA_DIR:?}/${state_dir}"
  ln -sfn "/data/ga/${state_dir}" "${GA_DIR}/${state_dir}"
done

# 注入平台操作 SOP（FEAT-09 软裁剪）：指引 GA 经 platform-command 执行平台操作。
# GA 的 prompt 只注入 memory/global_mem_insight.txt（ga.py get_global_memory），
# 其余 SOP 文件是按需读取——必须在 insight 里留指针，模型才知道 SOP 存在。
if [[ -f /opt/muad/ga/platform_command_sop.md && ! -f /data/ga/memory/platform_command_sop.md ]]; then
  cp /opt/muad/ga/platform_command_sop.md /data/ga/memory/platform_command_sop.md
fi
INSIGHT=/data/ga/memory/global_mem_insight.txt
SOP_HINT='[环境约束] 本机为 headless 服务器容器。铁律：平台操作先用 platform-command list/explain 查有无匹配 command——有 command 的领域只能走 platform-command，执行失败/不可执行就停下报告用户，严禁用脚本(requests/playwright/curl)自己代偿；无任何 command 覆盖的领域才可自由发挥。执行命令首选 pc-exec（防呆）：pc-exec <command> key=value...（真实执行，自动带 --execute-real --confirm）；参数只用裸 key=value，不要 -- 前缀/--param/--json，没有 --approve/--live，报错会附正确示例照着改、勿试错。截图/看公开网页可用 headless Chromium，但禁止用它做有 command 覆盖的操作、禁止读 /secrets。浏览器注入/键鼠/屏幕视觉/ADB 无载体不要尝试。详见 ../memory/platform_command_sop.md。'
touch "${INSIGHT}"
grep -qF 'platform_command_sop.md' "${INSIGHT}" || printf '\n%s\n' "${SOP_HINT}" >> "${INSIGHT}"

# 微信前端用扫码登录，token 存 ~/.wxbot —— 持久化到 data volume，避免重启丢失。
ln -sfn /data/ga/.wxbot "${HOME:-/root}/.wxbot" 2>/dev/null || true
mkdir -p /data/ga/.wxbot

# GA 前端选择：tui（默认）| wecom | dingtalk | tg | wechat（个人微信，扫码登录）
GA_FRONTEND="${GA_FRONTEND:-tui}"
case "${GA_FRONTEND}" in
  tui)      GA_SCRIPT="frontends/tuiapp_v2.py" ;;
  wecom)    GA_SCRIPT="frontends/wecomapp.py" ;;
  dingtalk) GA_SCRIPT="frontends/dingtalkapp.py" ;;
  tg)       GA_SCRIPT="frontends/tgapp.py" ;;
  wechat)   GA_SCRIPT="frontends/wechatapp.py" ;;
  *) echo "[muad] FATAL: 未知 GA_FRONTEND='${GA_FRONTEND}'（可选 tui|wecom|dingtalk|tg|wechat）" >&2; exit 1 ;;
esac

echo "[muad] user=${PLATFORM_COMMAND_USER_ID} frontend=${GA_FRONTEND}"
echo "[muad] platform-command $(node -p "require('/usr/lib/node_modules/@jahanxu/platform-command/package.json').version" 2>/dev/null || echo '?')"

cd "${GA_DIR}"
exec /opt/ga-venv/bin/python "${GA_SCRIPT}"
