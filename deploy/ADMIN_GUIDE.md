# 多用户 Agent 平台环境 — 管理员使用手册

面向管理员：如何构建镜像、开通用户、配置不同 IM 渠道、日常运维。

> 形态：每用户一个容器（GA Agent + platform-command + headless Chromium），
> 共享一份只读命令库，身份由容器环境变量锁定，互不可见。

---

## 0. 前置要求

- Docker（含 compose v2）、`envsubst`（gettext）、`rsync`
- 一份 LLM API key（OpenAI 兼容或 Claude 原生协议均可）
- 各用户的 IM 渠道凭证（见 §3）

---

## 1. 构建镜像

镜像 = 程序（GA + platform-command + 浏览器 + 命令库），所有用户容器共用。

```bash
cd deploy

# 正式镜像：装 npm registry 上的 platform-command + clone 上游 GA
./build-image.sh --pc-version 0.4.0 --ga-ref main

# 验证未发版的 platform-command 源码（npm pack 本地包，触发 build+test）
./build-image.sh --pc-local

# 用本地 GA fork（验证未合并的 GA 修复，如微信前端补丁）
./build-image.sh --pc-local --ga-local /path/to/GenericAgent
```

构建脚本会：
- 校验 Playwright 版本对齐（基础镜像 == npm 包 == platform-command 依赖）
- 扫描镜像，确保无凭证（mykey.py 等）残留
- tag 形如 `muad:pc<版本>-ga<ref>`；如需当默认，自行 `docker tag <tag> muad:latest`

> `--ga-local` 拷贝本地 fork 时自动排除 `.git`/`mykey.py`/`memory`/`skills`/`temp`，
> 不会把你 fork 里的个人数据或密钥带进镜像。

### 镜像升级

源码更新后重建镜像，再滚动升级容器（volume 数据不动）：

```bash
./build-image.sh --pc-version 0.4.1 ...        # 出新 tag
./upgrade.sh --tag muad:pc0.4.1-... --users alice   # 先试点
./upgrade.sh --tag muad:pc0.4.1-... --all           # 全量（需 tag 已在试点跑过）
# 回滚 = 指定旧 tag 重跑 upgrade.sh
```

---

## 2. 开通用户（通用流程）

```bash
# 1. 生成实例（compose + .env + mykey.py 三件套）
MUAD_IMAGE=muad:latest ./provision-user.sh <userId> --im <渠道>

# 2. 编辑凭证（见 §3 对应渠道）
vi users/<userId>/mykey.py      # LLM key + IM 凭证
vi users/<userId>/.env          # （可选）平台 API token

# 3. 启动（启动前会校验占位符与 allowed_users）
./provision-user.sh <userId> --start
```

- `<渠道>` ∈ `tui` | `wecom` | `wechat`
- userId 仅含字母数字与 `. _ -`
- 自定义实例目录加 `--dir <path>`（注意：不在 `deploy/users/` 下的实例不会被
  `upgrade.sh --all` 和 `fleet-status.sh` 自动覆盖）

每个用户独立拥有：
- 容器 `muad-<userId>`
- 三个 volume：登录态(secrets) / 平台数据(data) / GA 记忆(ga)
- `mykey.py`（凭证，不进 git）

---

## 3. 各 IM 渠道配置

> 所有渠道的 LLM 配置都在 `mykey.py` 的 `native_oai_config` + `mixin_config`，
> 填 apikey / apibase / model 三项即可（详见模板注释）。下面只列 IM 部分。

### 3.1 TUI（终端，无需 IM 凭证）

最简单，适合测试。无登录、无渠道凭证。

```bash
./provision-user.sh alice --im tui
vi users/alice/mykey.py          # 只填 LLM 三项
./provision-user.sh alice --start
docker attach muad-alice         # 进终端对话（Ctrl-P Ctrl-Q 退出不杀容器）
```

### 3.2 企业微信（wecom）

在 `mykey.py` 填三项（身份绑定：`allowed_users` 必须是该用户本人企微账号）：

```python
wecom_bot_id = '<企微智能机器人 ID>'
wecom_secret = '<机器人 Secret>'
wecom_allowed_users = ['<该用户的企微成员账号>']   # 禁止 ['*']/留空
# wecom_welcome_message = '你好，我在线上。'        # 可选
```

- 凭证来源：企业微信管理后台 → 创建**智能机器人**，拿到 bot_id + secret
- `wecom_allowed_users` 填该用户在企微的成员账号 ID（即消息回调里的 `from.userid`）；
  不确定时先填占位值启动，让用户发条消息，`docker logs muad-<id> | grep unauthorized`
  反查真实 userid，再填回重启
- 启动：`./provision-user.sh <id> --start`（校验会拦截 `['*']`/留空）
  - 确需对全租户开放（仅演示）：`--start --allow-public-im`（显式确认 + 警告）

### 3.3 个人微信（wechat，扫码登录）

`mykey.py` **无需 IM 凭证**——身份由"谁扫码"绑定。只填 LLM 三项。

```bash
./provision-user.sh alice --im wechat
vi users/alice/mykey.py          # 只填 LLM 三项
./provision-user.sh alice --start
docker logs -f muad-alice        # 看 ASCII 二维码，用该用户微信扫码
```

- 扫码成功后 token 持久化到 data volume（`/data/ga/.wxbot/token.json`），重启不丢
- 二维码会自动刷新；首次登录需镜像含 GA 微信前端修复（见下方"已知事项"）

---

## 4. 平台登录态（让命令以用户身份操作目标平台）

平台操作（查数据、导出、UI 写操作）需要用户在目标平台的登录态。两条路：

- **API token**：在 `users/<id>/.env` 配（如 `GITHUB_TOKEN=...`），命令直连，最简单
- **浏览器登录态**（storageState，用于需登录的网页类命令）：
  1. 用户本地登录目标平台，导出 storageState：
     `npx playwright open --save-storage=state.json <平台URL>`（登录后关窗）
  2. 管理员导入：`./import-storage-state.sh <userId> <平台host> state.json`
  - 登录态失效时命令会返回"登录态已失效"指引，重复导入即可恢复

---

## 5. 日常运维

```bash
./fleet-status.sh                # 全员健康：状态/内存/失效会话/失败run（--json 机器可读）
./fleet-status.sh --json

# 停止 / 重启某用户
docker stop muad-<id>  |  docker start muad-<id>

# 注销用户（删容器 + volume，不可逆）
docker rm -f muad-<id>
docker volume rm muad-<id>_muad-<id>-secrets muad-<id>_muad-<id>-data muad-<id>_muad-<id>-ga
rm -rf users/<id>
```

---

## 6. 安全要点

- **凭证不进镜像/git**：LLM key、IM 凭证在 `users/<id>/mykey.py`（chmod 600）；
  登录态在独立 secrets volume。镜像构建会扫描拦截凭证残留。
- **身份不可篡改**：userId 来自容器环境变量，命令参数/对话层无法改写。
- **IM 身份绑定**：wecom/钉钉/TG 的 `allowed_users` 必须限定到本人；wechat 由扫码绑定。
- **命令库只读**：`/opt/platform-commands` 只读挂载，含 signer 代码，仅管理员可改。
- **输出沙箱**：命令输出收敛到用户专属 output 目录，拒绝越界路径。
- 复用他人 LLM 配置时**只拷 LLM 段**，勿整份 cp mykey.py（会带入他人 IM 凭证）。

---

## 7. 已知事项

- **个人微信前端**依赖 GA 的修复（容器内扫码登录 + PIL 兜底等），需用打了补丁的
  GA fork 构建镜像（`--ga-local <fork路径>`）。上游 GA 原版在容器内无法首次扫码登录。
- 钉钉 / Telegram 前端：镜像已装 SDK，但本环境**未实测**，使用前请自行验证。
- 微信 QR 接口有频率限制，短时间反复重启容器可能触发限流（退避重试已内置，等待即可）。

---

## 8. 文件速查

| 文件 | 作用 |
|------|------|
| `Dockerfile` + `entrypoint.sh` | 基础镜像 |
| `build-image.sh` | 构建镜像（`--pc-local` / `--ga-local`） |
| `provision-user.sh` | 开通用户（`--im` / `--start` / `--dir` / `--allow-public-im`） |
| `import-storage-state.sh` | 导入浏览器登录态 |
| `upgrade.sh` / `fleet-status.sh` | 滚动升级 / 全员巡检 |
| `mykey.minimal.py` / `env.template` / `compose.template.yml` | 开通模板 |
| `ga/platform_command_sop.md` | GA 容器内行为约束（软裁剪） |
| `users/<id>/` | 用户实例（compose + .env + mykey.py，不进 git） |
