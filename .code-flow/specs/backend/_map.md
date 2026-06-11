# Backend Retrieval Map

> AI 导航地图：定位代码结构和关键模块。可由 `/cf-learn --map` 重生成。

## Purpose

MCP-first 的通用平台指令框架：项目内置公共 commands（JSON 定义），业务方通过外部 commands 目录扩展；Agent 优先走 MCP（stdio server，10 个 tools），不支持 MCP 的环境退回 CLI（`platform-command ...`）。`[README]`

## Architecture

- Language: TypeScript（ESM，`module: NodeNext`），Node >= 18 `[tsconfig.json] [package.json]`
- Build: `tsc` 编译到 `dist/`，CLI 与测试均运行 dist 产物 `[package.json scripts]`
- 接入层：MCP stdio server（`src/mcp_server.ts`）+ CLI（`src/cli.ts`）
- Command 定义：纯 JSON（`commands/<platform>/cmd/*.json`），框架解释执行
- 浏览器能力：webbridge 路由到用户真实浏览器；playwright 仅为 optionalDependency 兜底 `[package.json]`
- 部署形态：本地单用户（webbridge）+ 服务器多用户（显式 env 启用，每用户一容器，Playwright 适配器 + storageState），服务器产物见 `deploy/` `[deploy/]`

## Key Files

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI 入口，子命令分发（list/describe/execute/verify/doctor/mcp/...） |
| `src/mcp_server.ts` | MCP stdio server，暴露 platform_command_* tools |
| `src/command_store.ts` | 加载内置 + 外部 commands（`PLATFORM_COMMANDS_DIR`） |
| `src/execute.ts` | command 执行引擎，默认 dry-run |
| `src/describe.ts` | describe/explain/agent manifest，含 requirements + readiness |
| `src/verify.ts` | command / workflow 结构校验 |
| `src/acceptance.ts` | 真实执行后的验收契约核验（file_exists/data_contains） |
| `src/params_resolver.ts` | 参数解析与默认值合并 |
| `src/webbridge.ts` / `src/session.ts` | 浏览器桥接与 SPA session 判断（本地单用户路径） |
| `src/server_mode.ts` | 服务器模式配置（env 读取/校验、`resolveOutputPath` 沙箱、`resolveDataBaseDir` 数据落点锚定） |
| `src/playwright_adapter.ts` | 服务器模式浏览器适配器（storageState 会话内 fetch/page，deepQuery shadow 穿透） |
| `src/ui_executor.ts` | UI 写操作执行引擎（goto/fill/click/...，键盘输入、网络回执确认；engine `playwright_ui`） |
| `src/session_state.ts` | 会话失效标记（401/403 落盘、readiness 阻塞、重导入清除） |
| `src/doctor.ts` | command / 环境健康检查 |
| `src/schedule.ts` | 宿主调度器规格生成（不自动安装） |
| `src/runs.ts` | 执行日志（runs/）列举与汇总 |
| `src/utils.ts` | ROOT 定位、JSON IO、`maskHeaders`/`redactSensitive` 脱敏 |

## Module Map

```
src/                 # 平铺模块，无分层目录（cli/mcp_server/execute/verify/...）
commands/            # 内置 commands
├── <platform>/      # bilibili / github / sangfor
│   ├── cmd/         # command 定义 JSON
│   ├── config/      # *.defaults.json 默认参数
│   ├── code/        # 平台专用 JS 辅助代码
│   └── templates/   # 列定义等输出模板
├── demo.*.json      # 顶层 demo command
platforms/           # 平台 profile
templates/           # command/profile/run-log 脚手架模板
deploy/              # 服务器多用户部署产物
├── Dockerfile       # 基础镜像（Playwright 底 + GA + platform-command）
├── *.sh             # build-image / provision-user / import-storage-state / upgrade / fleet-status
├── compose.template.yml + env.template + mykey.minimal.py
├── ga/              # GA 容器约定（平台操作 SOP，软裁剪）
└── users/<userId>/  # 开通生成：compose.yml + .env + mykey.py（不进 git）
tests/run-tests.ts   # 单一测试入口（编译后跑 dist/tests）
runs/                # 执行日志输出
dist/                # tsc 构建产物
```

## Data Flow

```
Agent(MCP) / CLI → command_store 加载 JSON command
  → verify/describe（requirements + readiness 前置可见）
  → params_resolver 合并默认值
  → execute（默认 dry-run；--execute-real --confirm 才真实执行）
  → resolveAdapter 选适配器（本地 webbridge / 服务器 Playwright，只看显式 env）
  → webbridge / Playwright（HTTP 数据源或 UI 执行引擎）/ Node fetch
  → acceptance 核验 → runs/ 写执行日志（服务器模式带 userId/adapter，锚定 DATA_DIR）
```

## Navigation Guide

- 新增平台 command → `commands/<platform>/cmd/*.json`，参考 `templates/command-template.json` 与 `examples/create-command.md`
- 新增 MCP tool → `src/mcp_server.ts` 注册 + `src/cli.ts` 加对应子命令
- 改执行/dry-run 逻辑 → `src/execute.ts`；验收逻辑 → `src/acceptance.ts`
- 改参数解析/默认值 → `src/params_resolver.ts` + `commands/<platform>/config/`
- 浏览器相关问题 → 本地 `src/webbridge.ts`/`src/session.ts`；服务器 `src/playwright_adapter.ts`
- 服务器多用户模式 / 适配器选择 / 输出沙箱 / 数据落点 → `src/server_mode.ts`、`src/capabilities.ts resolveAdapter`
- UI 写操作（shadow DOM / 键盘输入 / 网络回执）→ `src/ui_executor.ts`
- 会话失效与重导入 → `src/session_state.ts`
- 部署/开通/升级/巡检 → `deploy/`（README + 脚本）
- 安全边界 → `docs/safety.md`
