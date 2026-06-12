#!/usr/bin/env bash
# CLI-03：构建基础镜像，tag 绑定 platform-command 与 GA 双版本（FEAT-01）。
# 用法: build-image.sh [--pc-version <npm版本>] [--ga-ref <git ref>] [--tag <自定义tag>]
#                       [--pc-local] [--ga-local <本地 GA fork 路径>]
# --ga-repo：GA 仓库地址（默认作者 fork，含微信补丁）；--ga-ref：分支。
# --ga-local：用本地 GA fork 目录（不走 git clone）。
set -euo pipefail
cd "$(dirname "$0")"

PC_VERSION="latest"
GA_REF="main"
# 默认 GA 源 = 作者 fork（含微信容器化补丁）；可用 --ga-repo 覆盖。
GA_REPO="https://github.com/Michaelxwb/GenericAgent"
CUSTOM_TAG=""
PC_LOCAL=false
GA_LOCAL_PATH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pc-version) PC_VERSION="$2"; shift 2 ;;
    --ga-ref)     GA_REF="$2"; shift 2 ;;
    --ga-repo)    GA_REPO="$2"; shift 2 ;;
    --tag)        CUSTOM_TAG="$2"; shift 2 ;;
    --pc-local)   PC_LOCAL=true; shift ;;
    --ga-local)   GA_LOCAL_PATH="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

# --pc-local：npm pack 本仓库源码（触发 prepack 的 build+test 闸门），
# 用于验证未发版代码；正式镜像走 --pc-version 装 registry 版本。
rm -rf pc-local && mkdir -p pc-local
if ${PC_LOCAL}; then
  echo "[build] npm pack 本地源码（prepack: build+test）..."
  # prepack 会跑 build+test；任一失败 npm pack 非零退出。显式拦截并给出清晰原因，
  # 而不是让 set -e 静默中止（镜像会停留在旧版本，难以察觉）。
  if ! (cd .. && npm pack --pack-destination deploy/pc-local); then
    echo "FATAL: npm pack 失败（通常是 prepack 的 build/test 未通过）。镜像未重建，请先修复测试后重试。" >&2
    exit 1
  fi
  # 双保险：确认确实产出了 tgz，否则后续 Dockerfile 会静默回退装 registry 版本。
  if ! ls pc-local/*.tgz >/dev/null 2>&1; then
    echo "FATAL: --pc-local 指定但未生成 pc-local/*.tgz，构建中止（避免误装 registry 版本）。" >&2
    exit 1
  fi
  PC_VERSION="local-$(node -p "require('../package.json').version")"
fi

# --ga-local：把本地 GA fork 拷入 ga-local/，排除 .git/凭证/per-user 状态/缓存。
# 镜像优先用 ga-local（见 Dockerfile）；否则该目录为空，回退 git clone 上游。
rm -rf ga-local && mkdir -p ga-local
if [[ -n "${GA_LOCAL_PATH}" ]]; then
  [[ -f "${GA_LOCAL_PATH}/agentmain.py" ]] || { echo "FATAL: ${GA_LOCAL_PATH} 不是 GA 仓库（无 agentmain.py）" >&2; exit 1; }
  echo "[build] 拷贝本地 GA fork: ${GA_LOCAL_PATH}（排除 .git/mykey.py/memory/skills/temp/缓存）"
  # 用 tar 管道拷贝（免装 rsync，几乎所有系统都有 tar），排除 .git/凭证/状态/缓存。
  # 失败即中止——否则 ga-local 为空会被 Dockerfile 静默回退成 git clone 上游（拿到无补丁的 GA）。
  if ! tar -C "${GA_LOCAL_PATH}" \
        --exclude='.git' --exclude='mykey.py' --exclude='__pycache__' --exclude='*.pyc' \
        --exclude='memory' --exclude='skills' --exclude='temp' --exclude='*.log' \
        --exclude='.venv' --exclude='venv' --exclude='node_modules' \
        -cf - . | tar -C ga-local -xf -; then
    echo "FATAL: 拷贝 GA fork 失败，构建中止（避免静默回退到 git clone 上游、丢失本地补丁）。" >&2
    exit 1
  fi
  # 双保险：确认确实拷进来了
  [[ -f ga-local/agentmain.py ]] || { echo "FATAL: ga-local/ 未拷入 GA 代码，构建中止。" >&2; exit 1; }
  GA_REF="local-fork"
fi

# 版本对齐校验（NFR-COMPAT-01）：FROM 镜像版本 == npm playwright 版本
BASE_PW_VERSION=$(grep -oE 'playwright:v[0-9]+\.[0-9]+\.[0-9]+' Dockerfile | head -1 | sed 's/playwright:v//')
NPM_PW_VERSION=$(grep -oE 'PLAYWRIGHT_NPM_VERSION=[0-9]+\.[0-9]+\.[0-9]+' Dockerfile | head -1 | cut -d= -f2)
if [[ "${BASE_PW_VERSION}" != "${NPM_PW_VERSION}" ]]; then
  echo "FATAL: Playwright 版本不对齐：基础镜像 v${BASE_PW_VERSION} != npm ${NPM_PW_VERSION}" >&2
  exit 1
fi
echo "[build] Playwright 版本对齐 ✓ (${BASE_PW_VERSION})"

TAG="${CUSTOM_TAG:-muad:pc${PC_VERSION}-ga$(echo "${GA_REF}" | tr '/' '-')}"
[[ -z "${GA_LOCAL_PATH}" ]] && echo "[build] GA 源: ${GA_REPO}@${GA_REF}"
docker build \
  --build-arg "PLATFORM_COMMAND_VERSION=${PC_VERSION}" \
  --build-arg "GA_REPO=${GA_REPO}" \
  --build-arg "GA_REF=${GA_REF}" \
  -t "${TAG}" .

# 镜像内不得含凭证（NFR-SEC-02）
echo "[build] 凭证扫描..."
if docker run --rm --entrypoint sh "${TAG}" -c 'test -f /opt/generic-agent/mykey.py'; then
  echo "FATAL: 镜像中发现 mykey.py，凭证不得进镜像" >&2
  exit 1
fi
echo "[build] 完成: ${TAG}"
