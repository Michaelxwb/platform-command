#!/usr/bin/env bash
# CLI-05：全部用户容器健康汇总（§4.5 批量 doctor）。
# 用法: fleet-status.sh [--json]
# 退出码: 0=全部健康 1=存在异常
set -euo pipefail
cd "$(dirname "$0")"

JSON=false
[[ "${1:-}" == "--json" ]] && JSON=true

UNHEALTHY=0
ROWS=()
for user_dir in users/*/; do
  [[ -d "${user_dir}" ]] || continue
  user=$(basename "${user_dir}")
  container="muad-${user}"
  state=$(docker inspect -f '{{.State.Status}}' "${container}" 2>/dev/null || echo "missing")
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${container}" 2>/dev/null || echo "-")
  mem=$(docker stats --no-stream --format '{{.MemPerc}}' "${container}" 2>/dev/null || echo "-")
  invalid_sessions=$(docker exec "${container}" sh -c 'ls /data/platform/.platform-command/sessions/*.json 2>/dev/null | wc -l' 2>/dev/null | tr -d ' ' || echo "-")
  failed_runs=$(docker exec "${container}" sh -c 'grep -l "\"status\": \"\(error\|failed\)\"" /data/platform/.platform-command/runs/*.json 2>/dev/null | wc -l' 2>/dev/null | tr -d ' ' || echo "-")
  if [[ "${state}" != "running" || "${health}" == "unhealthy" ]]; then
    UNHEALTHY=$((UNHEALTHY + 1))
  fi
  ROWS+=("{\"user\":\"${user}\",\"state\":\"${state}\",\"health\":\"${health}\",\"mem\":\"${mem}\",\"invalidSessions\":\"${invalid_sessions}\",\"failedRuns\":\"${failed_runs}\"}")
done

if ${JSON}; then
  printf '{"unhealthy":%d,"containers":[%s]}\n' "${UNHEALTHY}" "$(IFS=,; echo "${ROWS[*]:-}")"
else
  printf '%-16s %-10s %-10s %-8s %-14s %s\n' USER STATE HEALTH MEM INVALID_SESS FAILED_RUNS
  for row in "${ROWS[@]:-}"; do
    echo "${row}" | sed 's/[{}"]//g; s/user://; s/state://; s/health://; s/mem://; s/invalidSessions://; s/failedRuns://' \
      | awk -F, '{ printf "%-16s %-10s %-10s %-8s %-14s %s\n", $1, $2, $3, $4, $5, $6 }'
  done
fi
exit $((UNHEALTHY > 0 ? 1 : 0))
