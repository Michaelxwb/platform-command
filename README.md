# platform-command

`platform-command` 是一个 MCP-first 的通用平台指令框架：项目内置公共 commands，业务方可以通过外部 commands 目录补充自己的平台操作；不同 Agent 可以优先通过 MCP 调用，也可以退回 CLI 直接执行。

V3 的核心目标不是绑定某一个 Agent 的 skill 标准，而是提供一层稳定的“平台操作协议”：

- **MCP 接入**：Claude Code、Codex、OpenClaw、Hermes Agent 等只要支持 MCP，就可以接入同一套 tools。
- **CLI 兜底**：不支持 MCP 的环境，仍可用 `platform-command ...`。
- **公共 commands + 业务 commands**：仓库自带公共指令；业务项目通过外部目录扩展，不必改框架源码。
- **learn 可选浏览器能力**：`learn` 需要浏览器观察能力；Playwright 作为可选兜底依赖，不再是执行普通 commands 的硬前置。

## 快速开始

面向普通用户，推荐直接通过 npm 安装后使用全局命令：

```bash
npm install -g @jahanxu/platform-command
platform-command --help
platform-command list --json
platform-command verify --command demo.search_example
platform-command execute --command demo.search_example --dry-run keyword=abc
```

如果是从源码开发或调试本仓库：

```bash
npm install
npm run build
npm test
npm run list
```

## MCP 使用

启动 MCP stdio server：

```bash
platform-command mcp
# 或
npm run mcp
```

MCP server 当前提供 10 个 tools：

| Tool | 作用 |
| --- | --- |
| `platform_command_list` | 列出可用 commands |
| `platform_command_describe` | 查看单个 command 定义、参数和风险等级 |
| `platform_command_explain` | 自然语言解析并匹配 command |
| `platform_command_agent_manifest` | 返回 Agent 友好的 command 清单 |
| `platform_command_doctor` | 对 command 做健康检查 |
| `platform_command_verify` | 校验 command / workflow 结构 |
| `platform_command_execute` | 执行 command；默认 dry-run |
| `platform_command_schedule` | 生成宿主调度器规格（不自动安装） |
| `platform_command_docs` | 生成 command 目录 Markdown 文档 |
| `platform_command_learn` | 从 URL 学习平台动作，生成 command 草案 |

典型 Agent MCP 配置示例：

```json
{
  "mcpServers": {
    "platform-command": {
      "command": "platform-command",
      "args": ["mcp"],
      "env": {
        "PLATFORM_COMMANDS_DIR": "/path/to/my-business-commands"
      }
    }
  }
}
```

> 如果你的 Agent 运行环境找不到全局命令，也可以把 `command` 改成 `npx`，`args` 改成 `["@jahanxu/platform-command", "mcp"]`。业务 commands 可以通过 `PLATFORM_COMMANDS_DIR` 注入。

## 服务器多用户部署

把一套环境部署到服务器供多人使用、每人操作互相独立（每用户一个容器，绑定各自的
IM 渠道与平台登录态）：见 **[deploy/ADMIN_GUIDE.md](deploy/ADMIN_GUIDE.md)** —— 涵盖
镜像构建、用户开通、各 IM 渠道（TUI / 企业微信 / 个人微信）配置、平台登录态导入与运维。

> 本地单用户用法（上面的 MCP / CLI）不受影响：服务器模式由显式环境变量启用，
> 未设置时行为与现版本完全一致。

## 外部 commands 扩展

默认会加载仓库内置目录：

```text
commands/*.json
```

业务方可以把自己的命令放到单独目录，例如：

```text
my-business-commands/
├── crm.search_customer.json
└── order.refund_preview.json
```

本仓库已经提供一套可复制的外部 command 示例：

```text
examples/external-commands/
├── README.md
├── crm.search_customer.json      # API-first + UI fallback
└── order.refund_preview.json     # workflow command，串联多个步骤
```

你可以先直接运行示例：

```bash
PLATFORM_COMMANDS_DIR=examples/external-commands platform-command list --json
PLATFORM_COMMANDS_DIR=examples/external-commands platform-command verify --command crm.search_customer
PLATFORM_COMMANDS_DIR=examples/external-commands platform-command execute --command crm.search_customer --dry-run keyword=alice limit=5
```

CLI 也支持显式参数：

```bash
platform-command verify --commands-dir examples/external-commands --command order.refund_preview
platform-command execute --commands-dir examples/external-commands --command order.refund_preview --dry-run orderId=ORD-10001 reason=customer_request
```

复制到自己的业务项目时，通常只需要改这些字段：

1. `name`：改成 `<你的平台>.<你的动作>`，例如 `crm.search_customer`。
2. `platform`：平台名，例如 `crm`、`order`、`github`。
3. `parameters`：用户执行 command 时要传入的业务参数。
4. `execution.api` / `execution.ui` / `execution.workflow`：真实 API、页面路径和步骤。
5. `successCriteria`：业务成功标准，不能只写“HTTP 200”或“点击成功”。
6. `failureCases`：登录失效、权限不足、平台变更等失败场景。

加载规则：

1. 内置 commands 始终可用。
2. 外部 commands 通过 `PLATFORM_COMMANDS_DIR` 或 `--commands-dir` 添加。
3. 同名 command 优先使用外部目录，便于业务方覆盖公共 command。
4. command 文件名格式为 `<command-name>.json`。

## learn 与浏览器依赖

普通 list / verify / execute dry-run 不需要 Playwright 浏览器。

`learn` 用于观察页面、捕获 DOM 摘要、网络请求与用户操作轨迹，因此需要浏览器能力。V3 第一阶段保留 Playwright 作为可选兜底：

```bash
npm install
npx playwright install chromium
platform-command learn --platform demo --action inspect_example --url https://example.com --observe-seconds 5
```

如果运行环境没有安装 Playwright，只有调用 `learn` 时才会报出安装提示；其他 MCP/CLI command 能力不受影响。

learn 产物会写入：

```text
runs/<时间>_<平台>_<动作>/learn_report.json
```

报告默认不会保存密钥、明文 Cookie 或 Authorization 明文。

## 目录结构

```text
platform-command/
├── SKILL.md                         # skill-style 能力说明，保留给支持 skill 的 Agent
├── README.md                        # 项目说明
├── package.json                     # Node.js 项目配置
├── tsconfig.json                    # TypeScript 编译配置
├── src/                             # TypeScript 源码（编译产物在 dist/）
│   ├── cli.ts                       # CLI 入口，包含所有子命令
│   ├── mcp_server.ts                # MCP stdio server（tools/resources/prompts）
│   ├── command_store.ts             # 内置/外部 command 读取、列表、参数合并
│   ├── execute.ts                   # 指令执行 / workflow dry-run
│   ├── describe.ts                  # command 描述、自然语言解析、agent manifest
│   ├── learn.ts                     # 浏览器页面学习；Playwright 动态可选导入
│   ├── workflow.ts                  # 多步骤 API/UI workflow 计划生成
│   ├── schedule.ts                  # 宿主调度器规格生成与 crontab/schtasks 安装
│   ├── capabilities.ts              # auto_capability 执行引擎
│   ├── data_sources.ts              # HTTP JSON 数据源读取
│   ├── exporters.ts                 # Excel/Word/PPT 导出
│   ├── acceptance.ts                # 验收合同构建与自动评估
│   ├── params_resolver.ts           # 多层默认参数合并
│   ├── nl.ts                        # 自然语言指令解析与执行
│   ├── doctor.ts                    # command 健康检查
│   ├── verify.ts                    # command / workflow 结构校验
│   ├── runs.ts                      # 运行记录读写
│   ├── docs.ts                      # command 文档生成
│   ├── init.ts                      # command 脚手架初始化
│   ├── session.ts                   # 安全会话引用说明
│   ├── requirements.ts              # command 执行能力推断
│   ├── template.ts                  # Mustache 模板渲染
│   └── utils.ts                     # 通用工具函数
├── commands/                        # 公共内置 commands
├── platforms/                       # 平台资料与约束
├── templates/                       # command/profile 模板文件
├── examples/                        # 使用示例与外部 command 示例
├── docs/                            # 文档
└── tests/                           # 本地测试
```

## 轻量 Recipe command

推荐新增业务能力时优先使用轻量结构：`Command + Parameters + Steps + Checks`。框架只负责通用的参数合并、模板渲染、依赖排序、dry-run 计划和结构校验；具体业务流程直接写在 command JSON 里，不需要为每个系统新增 adapter。

```json
{
  "name": "demo.light_recipe",
  "platform": "demo",
  "description": "Search then open detail page.",
  "riskLevel": "low",
  "parameters": {
    "keyword": { "type": "string", "required": true }
  },
  "steps": [
    {
      "id": "search",
      "type": "api",
      "request": { "method": "GET", "url": "https://example.test/search?q={{params.keyword}}" },
      "extract": { "firstId": { "example": "item-001" } }
    },
    {
      "id": "open",
      "type": "ui",
      "dependsOn": ["search"],
      "ui": { "actions": [{ "action": "goto", "target": "https://example.test/items/{{steps.search.firstId}}" }] }
    }
  ],
  "checks": [
    "Search request is prepared.",
    "Detail page can be opened."
  ]
}
```

旧版 `execution.workflow.steps` 仍然兼容；新 command 建议优先写顶层 `steps` / `checks`，避免把简单业务流程设计成重型 workflow/adapter。

## 其他常用命令

**新建 command 脚手架**

```bash
platform-command init --platform crm --action search_customer
# 在 commands/ 生成 crm.search_customer.json 骨架，可直接 verify
platform-command verify --command crm.search_customer
```

**自然语言解析与执行**

```bash
# 解析自然语言，输出匹配的 command 和参数（不执行）
platform-command ask "在 GitHub 上查看 Michaelxwb/platform-command 的 issues，状态 all"

# 解析并执行 dry-run
platform-command ask "列出 GitHub 仓库 Michaelxwb/platform-command 的 commits，分支 master" --json
```

**查看运行记录**

```bash
platform-command runs                 # 最近 20 次运行记录
platform-command runs --summary       # 按 status 汇总
platform-command runs --limit 50      # 最近 50 条
```

**健康检查**

```bash
platform-command doctor --command github.list_issues   # 检查单个 command
platform-command doctor                                # 检查所有 command + 环境
```

**定时调度规划**

```bash
# 生成调度规格（不安装）
platform-command schedule plan --command github.list_issues --cron "0 9 * * *" --json repo=platform-command

# 安装到系统 crontab（dry-run 预览）
platform-command schedule install --command github.list_issues --cron "0 9 * * *" --dry-run repo=platform-command

# 确认安装
platform-command schedule install --command github.list_issues --cron "0 9 * * *" --confirm repo=platform-command

# 查看已安装调度
platform-command schedule list

# 删除
platform-command schedule remove --id <schedule-id> --confirm
```

**生成 command 文档**

```bash
platform-command docs                        # 输出 Markdown 到 stdout
platform-command docs --output docs/api.md   # 写入文件
```

## 指令生命周期

```text
学习页面流程 → 提取接口/参数 → 生成 command → verify → dry-run → 执行 → 验证业务结果 → 平台变化后更新
```

## 执行示例

单接口/单页面回退指令：

```bash
platform-command execute --command demo.search_example --dry-run keyword=abc page=1
```

多步骤 workflow 指令：

```bash
platform-command verify --command demo.workflow_example
platform-command execute --command demo.workflow_example --dry-run keyword=abc limit=5
```

低风险 GitHub 查询真实执行示例：

```bash
platform-command verify --command github.inspect_repository
platform-command execute --command github.inspect_repository --execute-real --confirm owner=zhaoxuya520 repo=reverse-skill branch=main
platform-command execute --command github.list_commits --execute-real --confirm owner=zhaoxuya520 repo=reverse-skill branch=main
platform-command execute --command github.list_issues --execute-real --confirm owner=zhaoxuya520 repo=reverse-skill
platform-command execute --command github.search_repositories --execute-real --confirm keyword=platform-command limit=3
```

默认推荐先使用 `--dry-run`，确认参数、执行路径、步骤依赖、会话引用和风险等级后，再考虑真实执行。

真实执行分两类：

- **框架内置可执行能力**：command 声明 `dataSource` + `output` 后，CLI/MCP 可以直接执行低风险读操作，例如 HTTP JSON 查询并 `return_json` / `save_json`。GitHub 查询类 command 已按这种方式接入，真实执行不需要站点 adapter。
- **Agent/WebBridge 执行能力**：复杂 Web 写操作仍由 Agent 按 command JSON 里的 recipe/workflow 控制浏览器或调用已学习到的接口执行；JSON 负责描述参数、步骤、校验和风险边界，框架负责通用解析、dry-run、校验和分发，不把每个站点逻辑写死进框架。

## 执行后端与环境最佳实践

普通 list / verify / execute `--dry-run`，以及公开只读接口的真实执行（如 GitHub 查询类）都**不需要浏览器**。只有当 command 需要**登录态接口**或**UI 写操作**时，才需要一个能控制浏览器、携带真实登录会话的执行后端。

按 command 的能力需求区分：

| command 能力需求 | 需要浏览器 | 执行方式 |
| --- | --- | --- |
| 公开只读接口 | 否 | Node 直接 HTTP，开箱即用 |
| 登录态接口（Cookie / CSRF） | 是 | 浏览器后端在已登录上下文发请求 |
| UI 写操作（填表 / 点击 / shadow DOM） | 是 | 浏览器后端驱动页面操作 |

### 按环境选择浏览器后端

| 环境 | 推荐后端 | 浏览器 | 理由 |
| --- | --- | --- | --- |
| **带桌面的电脑** | **Kimi WebBridge** | Chrome | 复用你已登录的真实 Chrome 会话（含 httpOnly Cookie、零信任隧道），登录态 / 零信任站点（如 aTrust）最省事；适合人工在场 |
| **服务器 / 无头** | **Playwright** | Chrome / Chromium | 持久化 profile 提前登录一次即可复用，可移植、可自动化，适合无人值守 |
| **纯公开 API** | Node（无浏览器） | — | 无前置依赖，装完即用 |

**桌面 · Kimi WebBridge + Chrome**：

```bash
# 安装并启动 daemon
curl -fsSL https://cdn.kimi.com/webbridge/install.sh | bash
# 健康检查：需 running: true 且 extension_connected: true
~/.kimi-webbridge/bin/kimi-webbridge status
```

再安装浏览器扩展（见 https://www.kimi.com/features/webbridge ，中文 https://www.kimi.com/zh-cn/features/webbridge ）并在 Chrome 登录目标站点。之后 Agent 通过本机 daemon（`127.0.0.1:10086`）在真实会话里执行接口或 UI 操作。零信任站点（aTrust 等）走本机隧道，这是最稳的执行点。

**服务器 · Playwright + Chrome**：

```bash
npm install playwright
npx playwright install chromium   # 或指定本机 Chrome channel
```

用持久化用户目录（Playwright 的 `launchPersistentContext`）提前登录目标站点一次，之后复用该 profile 携带登录态执行——与桌面 WebBridge 等价地满足「已登录浏览器会话」，区别只在可移植性与是否需要人工在场。

### 原则

- **后端由环境显式选择，框架不自动猜**：避免同一 command 在不同机器行为漂移，或静默选到未登录的后端导致误导性 401。
- **用到才要求**：第一次执行需要浏览器的 command 时，框架明确提示缺什么（后端未配 / profile 未登录 / Playwright 未安装）并给出修复方式，而不是安装时就强制依赖。
- **公开能力开箱即用**：不需要浏览器的 command 装完即可运行，不要求任何人安装浏览器。

## 安装与分发

### 作为 MCP server 使用

```bash
npm install
platform-command mcp
```

在支持 MCP 的 Agent 中，把 stdio server 配置为执行 `platform-command mcp`。如果 Agent 环境找不到全局命令，也可以配置为 `npx @jahanxu/platform-command mcp`。Agent 连接后可以发现：

- tools：list / describe / verify / execute；
- resources：`platform-command://commands`、`platform-command://distribution`；
- prompts：生成业务 command、安全执行 command。

### 作为通用框架扩展业务 command

公共 command 放在项目 `commands/*.json`。业务方可以任选一种方式扩展：

```bash
# 方式 1：在自己的目录维护 command 包
export PLATFORM_COMMANDS_DIR=/path/to/my-business-commands
platform-command list --json

# 方式 2：CLI 临时指定
platform-command list --json --commands-dir /path/to/my-business-commands
```

外部 command 与内置 command 同名时，外部 command 优先。`list --json` 会展示每个 command 的 source 与 package 信息，便于分发和排障。

### learn 的浏览器依赖策略

`playwright` 是 optional dependency。没有安装 Playwright 或浏览器时，learn 不再直接失败，而是生成 fallback 报告：

```bash
platform-command learn --platform demo --action inspect --url https://example.com --provider manual
platform-command learn --platform demo --action inspect --url https://example.com --provider http
```

如果需要真实浏览器学习能力，再安装：

```bash
npm install playwright
npx playwright install chromium
```

## 当前 V3 能力

### 第一阶段：MCP-first 基座

- MCP stdio server 基座；
- CLI `mcp` 子命令；
- 内置 commands + 外部 commands 目录；
- `PLATFORM_COMMANDS_DIR` 与 `--commands-dir`；
- command / workflow 结构校验；
- execute dry-run；
- learn Playwright 可选化；
- MCP/CLI/外部 commands 自动化测试。

### 第二阶段：通用分发框架增强

- `list --json` 返回 command 的 source 与 package metadata，便于区分 builtin / external command package；
- MCP server 支持 tools、resources、prompts 三类能力；
- MCP resources 暴露 command catalog 与 distribution guide；
- MCP prompts 提供“生成业务 command”和“安全执行 command”的 Agent 指引；
- learn 支持 provider/fallback provider：Playwright 可用时浏览器学习，不可用时自动生成 HTTP 或 manual fallback 报告；
- 测试覆盖 command package metadata、MCP resources/prompts、learn fallback。

## 安全原则

- 默认使用 dry-run，避免误操作。
- 不保存密码、私钥、原始 Cookie、原始 Authorization 等敏感信息。
- 删除、支付、退款、批量修改、权限变更、外部消息发送等动作视为高风险。
- 高风险动作必须显式确认。
- 成功不能只看按钮是否点击或接口是否返回 200，必须验证业务结果是否符合预期。
