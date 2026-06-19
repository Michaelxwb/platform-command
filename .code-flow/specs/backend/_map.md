# Backend Retrieval Map

> AI 导航地图：定位后端代码结构和关键模块。可由 `/cf-learn --map` 重生成，建议按真实项目手动校准。

## Purpose

后端服务，负责 API 暴露、业务逻辑与数据持久化。默认假设为分层架构（API → Service → Model）。

## Architecture

- Framework: 任意 Web 框架（FastAPI / Express / Spring / Gin 等）
- ORM/Driver: 与数据库匹配的官方/主流驱动
- Database: 关系型为主（PostgreSQL / MySQL），可叠加缓存（Redis）
- Auth: Token-based（JWT / OAuth2 / Session）
- Async: 必要时引入消息队列或后台任务（Celery / Bull / BullMQ）

## Key Files

| File | Purpose |
|------|---------|
| `src/main.*` | 应用入口，初始化框架、路由、中间件 |
| `src/api/router.*` | 路由注册，统一前缀与版本 |
| `src/services/` | 业务逻辑实现，禁止跨层调用 ORM |
| `src/models/` | 数据模型定义（ORM / Schema） |
| `src/config/` | 配置加载，环境变量优先 |

## Module Map

```
src/
├── api/         # 接口层：路由 + 请求/响应 schema 校验
├── services/    # 业务逻辑层：纯函数为主，便于测试
├── models/      # 数据模型（ORM 或 ODM）
├── schemas/     # DTO / 请求响应类型
├── middleware/  # 认证、日志、限流、CORS
├── utils/       # 工具函数，无业务依赖
└── config/      # 配置与环境变量
```

## Data Flow

```
Request → Middleware(auth/log) → Router → Handler(API)
        → Service(业务) → Model(DB/Cache) → Response
```

## Navigation Guide

- 新增 API → `api/` 加路由 + `schemas/` 定义请求响应 + `services/` 实现业务
- 新增表 → `models/` 定义模型 + `migrations/` 加迁移脚本
- 错误处理 → 抛业务异常类，由中间件统一转 HTTP 响应
- 配置项 → `config/` 集中管理，禁止散落 `os.environ`/`process.env`

## Platform-command 引擎（本仓库实际结构，覆盖上面的通用模板）

> 本仓库 src 是分层执行引擎（非 api/service/model）。导出链路关键模块：

| File | Purpose |
|------|---------|
| `src/engine/execute.ts` | `getExecutionCapability`：按命令形态选引擎（interceptFlow→ui_intercept / dataSource+output→auto_capability / store→store_op / workflow） |
| `src/engine/intercept_executor.ts` | 浏览器拦截引擎（interceptFlow）：urlBuilder 拼导出 URL → `page.route` 改写 `get_history_pwd.export_locales`（注入小语种）→ 抓 `generate_report` 的 task_id → `pollUntilReady` 轮询 `report_status` 至 `task_status==1` |
| `src/engine/capabilities.ts` | auto_capability；`resolveAdapter`（node_http / webbridge）；`download` 能力（存二进制响应到文件） |
| `src/engine/data_sources.ts` | http_json 取数；`responseType:"binary"` 二进制下载 + `parseDownloadFilename` |
| `src/adapter/playwright_adapter.ts` | `withPlaywrightPage` / `fetchViaPlaywright`；`chromeLaunchOptions`（读 `PLATFORM_COMMAND_CHROME_PATH`/`HEADLESS`/`CHROME_CHANNEL`） |
| `commands/mss/cmd/export_*.json` + `commands/mss/code/*.js` | MSS 导出命令 + command-local 钩子（export_url / export_locales / …） |

### interceptFlow 导出 — 维护必读
- **一套代码、两环境，仅差"补浏览器"**：soar 是 aTrust 零信任内网。生产 Docker 镜像自带 chromium，全自动（含 daemon 定时）；调试沙箱直连 soar（**不用代理**）但无 bundled chromium——把 `chromium-1223` 拷进共享的 `<项目>/.pw-browsers/` 并设 `PLAYWRIGHT_BROWSERS_PATH` 即可。**不用 managed Chrome**（`executablePath` 指向「MSS研发」Chrome 实测不稳）、不用 chrome-mcp。
- **capture task_id 易超时（已修）**：`generate_report` 响应可能因 SPA/worker/`resp.json()` 时序没被 `page.on('response')` 接住，导致旧版死等 `waitMs` 超时。`pollUntilReady` 已加**快照差集兜底**：触发前对 `report_status` 打 task_id 快照（`excludeIds`），capture 没抓到 task_id 时清空 `matchValue`、只认"快照外新增 + `task_status==1`"的行并回填其 task_id——截没截到都能拿到，不再死等。response 监听已在 `goto` 之前挂好。
- **小语种**为前端 i18n 静态资源（`/ui-report/static/remote/<code>/`，code=th/id/de/it…），**无后端 API**；靠 `page.route` 改写 `export_locales=[en,<code>]`（`export_locales.js`）注入。`mss.set_locale` 设的是 `local_locale`（客户报告语种配置），与导出语种无关，勿混用。
