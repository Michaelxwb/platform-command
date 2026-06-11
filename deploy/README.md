# deploy/ — 多用户 Agent 平台操作环境部署产物

> 📖 **管理员完整使用手册见 [ADMIN_GUIDE.md](ADMIN_GUIDE.md)**：构建镜像、开通用户、
> 各 IM 渠道（TUI / 企业微信 / 个人微信）配置、平台登录态、日常运维、安全要点。
> 本文档为产物清单与速查，新手请直接读 ADMIN_GUIDE。

对应设计文档 `.code-flow/tasks/2026-06-10/multi-user-agent-deployment.design.md`。

## 架构

每用户一个容器（GA + platform-command + headless Chromium），共享只读命令库，
身份（`PLATFORM_COMMAND_USER_ID`）由容器 env 注入——模型不可篡改。

## 文件

| 文件 | 作用 |
|------|------|
| `Dockerfile` + `entrypoint.sh` | 基础镜像（FEAT-01） |
| `build-image.sh` | CLI-03 构建镜像，tag 绑定 pc/GA 双版本，校验 Playwright 版本对齐 |
| `compose.template.yml` + `env.template` | 每用户编排模板（FEAT-02） |
| `provision-user.sh` | CLI-01 生成用户环境（退出码 2=已存在） |
| `import-storage-state.sh` | CLI-02 导入登录态（退出码 3=文件非法） |
| `upgrade.sh` | CLI-04 滚动升级（--all 需 tag 已过试点） |
| `fleet-status.sh` | CLI-05 全员健康汇总（退出码 1=有异常） |
| `ga/` | GA 容器约定：平台操作 SOP（软裁剪）+ mykey 约定说明 |
| `users/<userId>/` | 开通生成：compose.yml + .env + mykey.py（**不进 git**） |

## 典型流程

```bash
./build-image.sh --pc-version 0.4.0 --ga-ref main      # 1. 构建镜像
./provision-user.sh alice --im wecom                    # 2. 生成 alice 环境
vi users/alice/mykey.py                                 # 3. 填 LLM key + IM 凭证 + allowed_users（身份绑定）
docker compose -p muad-alice -f users/alice/compose.yml up -d   # 4. 启动
./import-storage-state.sh alice api.example.com s.json  # 5. 导入登录态（浏览器命令需要）
./upgrade.sh --tag muad:pc0.4.1-ga... --users alice     # 试点升级
./upgrade.sh --tag muad:pc0.4.1-ga... --all             # 全量（需 tag 已在试点运行）
./fleet-status.sh --json                                 # 巡检
```

> GA（GenericAgent）是第三方开源项目，安装与配置遵循其官方 `docs/installation_zh.md`：
> 源码可编辑安装（非 PyPI 包）、凭证走 `mykey.py`、memory/skills/temp 为用户状态
> （容器内由 entrypoint 落到 /data/ga volume 持久化）。

## 版本约定

- 镜像 tag：`muad:pc<platform-command版本>-ga<GA ref>`
- Playwright 三方对齐（NFR-COMPAT-01）：FROM 镜像版本 == npm playwright 版本 ==
  platform-command optionalDependencies（^1.52）。build-image.sh 强制校验前两者。

## 安全基线

- 凭证不进镜像、不进 git：`users/*/.env`（chmod 600）+ secrets volume
- 命令库 `:ro` 挂载，signer 代码仅管理员可变更（FEAT-08）
- 容器资源限额 + healthcheck + `restart: unless-stopped`（NFR-SEC-03 / RISK-C）

## 用户导出 storageState 指引（FEAT-04）

1. 本地浏览器登录目标平台
2. 任选一种导出：
   - Playwright 用户：`npx playwright open --save-storage=state.json <平台URL>`，登录后关闭窗口
   - 或使用浏览器扩展导出 cookie 后转换为 storageState 格式（`{ "cookies": [...], "origins": [...] }`）
3. 将 `state.json` 交给管理员执行 `import-storage-state.sh`
4. 登录态过期时（命令返回"登录态已失效"），重复上述步骤

> v1 约定：每用户单一合并 storageState 文件（cookies 按 domain 区分，多平台可共存）。
