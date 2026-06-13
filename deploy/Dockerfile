# 多用户 Agent 平台操作环境基础镜像（FEAT-01）
# 版本对齐约束（NFR-COMPAT-01）：FROM 的 Playwright 版本必须与
# package.json optionalDependencies.playwright（^1.52.0）一致，
# build-image.sh 会在构建前校验。
FROM mcr.microsoft.com/playwright:v1.52.0-noble

# GenericAgent 需要 Python 3.11/3.12（noble 默认 3.12）
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip git \
    && rm -rf /var/lib/apt/lists/*

# platform-command + 与镜像浏览器二进制一致的 playwright npm 包。
# pc-local/ 内若存在 npm pack 产物（build-image.sh --pc-local 生成），
# 优先安装本地包（未发版的代码验证用）；否则装 npm registry 版本。
ARG PLATFORM_COMMAND_VERSION=latest
ARG PLAYWRIGHT_NPM_VERSION=1.52.0
COPY pc-local/ /tmp/pc-local/
RUN if ls /tmp/pc-local/*.tgz >/dev/null 2>&1; then \
      npm install -g /tmp/pc-local/*.tgz "playwright@${PLAYWRIGHT_NPM_VERSION}"; \
    else \
      npm install -g "@jahanxu/platform-command@${PLATFORM_COMMAND_VERSION}" "playwright@${PLAYWRIGHT_NPM_VERSION}"; \
    fi \
    && rm -rf /tmp/pc-local \
    && platform-command list --json >/dev/null && echo "platform-command OK"

# GenericAgent（第三方开源项目，按 ref 锁定版本；安装方式遵循官方
# docs/installation_zh.md 方法二：源码可编辑安装。GA 不是 PyPI 包，
# 禁止 pip install genericagent）。容器为 headless：不装 [ui] extra
# （pywebview 需 GTK/WebKit 桌面依赖），TUI 依赖 textual 单独补。
# ga-local/ 内若有本地 fork 代码（build-image.sh --ga-local 拷入，已排除
# .git/mykey.py/memory 等），优先用本地 fork（验证未合并的修复）；否则 git clone 上游。
# 默认用本仓库作者的 fork（含微信前端容器化补丁等），上游 lsdefine/GenericAgent 不含这些修复。
# 需要换源/换分支时用 build-image.sh 的 --ga-repo / --ga-ref 覆盖。
ARG GA_REPO=https://github.com/Michaelxwb/GenericAgent
ARG GA_REF=main
COPY ga-local/ /tmp/ga-local/
RUN if [ -f /tmp/ga-local/agentmain.py ]; then \
      mkdir -p /opt/generic-agent && cp -r /tmp/ga-local/. /opt/generic-agent/ && echo "GA from local fork"; \
    else \
      git clone --depth 1 --branch "${GA_REF}" "${GA_REPO}" /opt/generic-agent && echo "GA from ${GA_REPO}@${GA_REF}"; \
    fi \
    && rm -rf /tmp/ga-local /opt/generic-agent/mykey.py \
    && python3 -m venv /opt/ga-venv \
    && /opt/ga-venv/bin/pip install --no-cache-dir -e /opt/generic-agent \
    && /opt/ga-venv/bin/pip install --no-cache-dir textual wecom_aibot_sdk dingtalk-stream python-telegram-bot qrcode pillow pycryptodome \
    # GA 浏览器后端 playwright_driver 用：pin 1.52.0 与基础镜像/npm 对齐，
    # 复用镜像已有的 /ms-playwright/chromium-1169，无需再下载浏览器二进制。
    && /opt/ga-venv/bin/pip install --no-cache-dir "playwright==${PLAYWRIGHT_NPM_VERSION}" \
    && /opt/ga-venv/bin/python -c "import sys; sys.path.insert(0, '/opt/generic-agent'); import agent_loop; from playwright.sync_api import sync_playwright; print('GA + py-playwright import OK')"

# 全局命令库挂载点（管理员维护，运行时只读挂载，FEAT-08）
ENV PLATFORM_COMMANDS_DIR=/opt/platform-commands
RUN mkdir -p /opt/platform-commands /data/platform /data/ga /secrets/storage-state

# GA 容器配置（工具裁剪等，FEAT-09）
COPY ga/ /opt/muad/ga/
COPY entrypoint.sh /usr/local/bin/muad-entrypoint.sh
# pc-exec：防呆执行包装，装进 PATH，供 GA 调用（隐藏 --execute-real --confirm）
RUN install -m 0755 /opt/muad/ga/pc-exec.sh /usr/local/bin/pc-exec \
    && chmod +x /usr/local/bin/muad-entrypoint.sh

# 凭证一律不进镜像（NFR-SEC-02）：本 Dockerfile 不 COPY 任何密钥/登录态，
# token、IM 凭证经 env 注入，storageState 经独立 volume 挂载。
WORKDIR /data/platform
ENTRYPOINT ["/usr/local/bin/muad-entrypoint.sh"]
