# AGENTS.md — 用 platform-command 操作 MSS

通过 `platform-command` CLI 操作 MSS 海外报告平台。完整说明见 `docs/mss-report-commands.md`；本文件是必守的执行规范，冲突以本文件为准。

> 适用范围：本文件供**本地/调试沙箱**的编码 agent 读取，**不进容器**（不在 npm 包，Dockerfile 不拷）。容器内 agent 的必守子集已蒸馏进 `deploy/ga/platform_command_sop.md` 的「MSS 编排铁律」段——**改动下方铁律时，请同步更新那份 SOP**，避免两处漂移。

## 一套代码、一套配置，两环境
- **生产**：Docker 容器（headless），镜像自带 chromium，导出命令开箱即用。**周/月定时导出由容器内 GA 调度框架驱动**（建 `sche_tasks` 任务调 `mss.export_weekly`/`mss.export_monthly`），**不依赖** platform-command 自带 daemon（那是本地/独立部署形态）。
- **调试沙箱**：本身直连 soar（**不用代理**）。与生产唯一差异：沙箱缺 bundled chromium，**手动补一次**（见下）。
- 命令/参数/流程两环境完全一致。**不要为环境改代码或分叉。**

## 调命令
- 预演（默认）：`platform-command execute --command mss.<x> <key=value ...>`
- 真跑：加 `--execute-real --confirm`。返回含 `"status":"dry_run"` = **没真跑**。
- 先 `platform-command list` / `verify --command mss.<x>` 查命令与参数；报错会附正确示例，照改、**勿试错**。参数用裸 `key=value`。

## 登录态（首次/过期）
- 自检：`platform-command session status`（ready=false 或命令 401/403 时需重取）。
- 取会话：在「MSS研发」Chrome 登录 → 取整条 Cookie（DevTools→Network→任一 soar 请求→请求头 Cookie，**含 httpOnly 的 soc-token/csrf_token**）→
  `platform-command session import-cookie --host soar.sea.sangfor.com --cookie "<整串>"` → 按输出设 `PLATFORM_COMMAND_STORAGE_STATE`。会话 ~6h。

## 导出（interceptFlow，Playwright；非导出走 node fetch）
- 非导出命令（搜客户/查状态/发邮件/同步/配置/下载）：node fetch + Cookie 直连 soar，零浏览器。
- 导出（`mss.export_weekly` / `export_monthly` / `export_report`）：interceptFlow 用 Playwright 开导出页 → `page.route` 改写 `export_locales` 注入小语种 → 抓 `generate_report` 的 task_id（抓不到走 `report_status` 快照差集兜底）→ 轮询至 `task_status==1`。**一条命令全自动，不需要手动开浏览器/抓包。**
- 小语种零降级由 interceptFlow 自动注入（`export_locales.js`）；`mss.set_locale` 是另一回事（客户 `local_locale`），别拿它加导出语种。
- 下载文件：`mss.download_report taskId=`（纯 node）。

### 沙箱补 chromium（仅此一项手动，一次性）
```bash
# Playwright 标准 chromium 已拷到共享项目目录 <项目>/.pw-browsers/（chromium-1223，arm64）
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.pw-browsers"
export PLATFORM_COMMAND_USER_ID=local
export PLATFORM_COMMAND_STORAGE_STATE=$PWD/.platform-command/storage-state.json
# 需看界面调试可：export PLATFORM_COMMAND_HEADLESS=false
```
> 不用代理、不用 managed Chrome（executablePath 实测不稳）、不用 chrome-mcp。

## 铁律（违反必错，调用 MSS 命令前后一律遵守）
1. 报错/返回非 0 code **原样回传，禁止自动重试**；401/403 提示刷新登录态，禁止忽略鉴权错误。
2. 同一动作**禁止连续重试同一命令**；失败交用户、等指示。
3. **禁止拼接/猜测参数**；参数须来自用户明确提供或 store 已有值。
4. **`task_id` 不臆造**：由 interceptFlow 抓取/兜底得到，或用户提供；`companyId` 用 `mss.search_company` 查。
5. 客户名多候选 → **让用户/你选定，禁止替选或自猜 companyId**。
6. **未明确要求禁止自动触发** 导出 / 发邮件 / 同步 portal。
7. **导出必须明确 weekly/monthly**，未指定先问。
8. **同一客户串行**；批量是跨不同客户并发，单客户内仍串行。
9. **邮箱增删只走 `mss.update_email`**，禁止经 `update_config` 改邮箱。
10. 收件人最终 = 平台邮箱 + 本地 added − removed（store delta）。
11. 纯业务交流**只用业务语言**，不暴露内部字段名/技术细节。
12. 定时须 `HH:MM` 24h；解析存疑**先与用户确认**。
