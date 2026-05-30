# platform-command

`platform-command` 是一个 MCP-first 的通用平台指令框架：项目内置公共 commands，业务方可以通过外部 commands 目录补充自己的平台操作；不同 Agent 可以优先通过 MCP 调用，也可以退回 CLI 直接执行。

V3 的核心目标不是绑定某一个 Agent 的 skill 标准，而是提供一层稳定的“平台操作协议”：

- **MCP 接入**：Claude Code、Codex、OpenClaw、Hermes Agent 等只要支持 MCP，就可以接入同一套 tools。
- **CLI 兜底**：不支持 MCP 的环境，仍可用 `node src/cli.js ...`。
- **公共 commands + 业务 commands**：仓库自带公共指令；业务项目通过外部目录扩展，不必改框架源码。
- **learn 可选浏览器能力**：`learn` 需要浏览器观察能力；Playwright 作为可选兜底依赖，不再是执行普通 commands 的硬前置。

## 快速开始

```bash
npm install
npm test
node src/cli.js --help
node src/cli.js list --json
node src/cli.js verify --command demo.search_example
node src/cli.js execute --command demo.search_example --dry-run keyword=abc
```

## MCP 使用

启动 MCP stdio server：

```bash
node src/cli.js mcp
# 或
npm run mcp
```

MCP server 当前提供 4 个 tools：

| Tool | 作用 |
| --- | --- |
| `platform_command_list` | 列出可用 commands |
| `platform_command_describe` | 查看单个 command 定义、参数和风险等级 |
| `platform_command_verify` | 校验 command / workflow 结构 |
| `platform_command_execute` | 执行 command；默认 dry-run |

典型 Agent MCP 配置示例：

```json
{
  "mcpServers": {
    "platform-command": {
      "command": "node",
      "args": ["/path/to/platform-command/src/cli.js", "mcp"],
      "env": {
        "PLATFORM_COMMANDS_DIR": "/path/to/my-business-commands"
      }
    }
  }
}
```

> 路径请替换为实际安装目录。业务 commands 可以通过 `PLATFORM_COMMANDS_DIR` 注入。

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
PLATFORM_COMMANDS_DIR=examples/external-commands node src/cli.js list --json
PLATFORM_COMMANDS_DIR=examples/external-commands node src/cli.js verify --command crm.search_customer
PLATFORM_COMMANDS_DIR=examples/external-commands node src/cli.js execute --command crm.search_customer --dry-run keyword=alice limit=5
```

CLI 也支持显式参数：

```bash
node src/cli.js verify --commands-dir examples/external-commands --command order.refund_preview
node src/cli.js execute --commands-dir examples/external-commands --command order.refund_preview --dry-run orderId=ORD-10001 reason=customer_request
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
node src/cli.js learn --platform demo --action inspect_example --url https://example.com --observe-seconds 5
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
├── src/
│   ├── cli.js                       # CLI 入口，包含 mcp 子命令
│   ├── mcp_server.js                # MCP stdio server
│   ├── command_store.js             # 内置/外部 command 读取、列表、参数合并
│   ├── execute.js                   # 指令执行 / workflow dry-run
│   ├── learn.js                     # 浏览器页面学习；Playwright 动态可选导入
│   ├── workflow.js                  # 多步骤 API/UI workflow 计划生成
│   ├── session.js                   # 安全会话引用说明
│   ├── utils.js                     # 通用工具函数
│   └── verify.js                    # command / workflow 结构校验
├── commands/                        # 公共内置 commands
├── platforms/                       # 平台资料与约束
├── runs/                            # learn 执行产物
├── templates/                       # 模板文件
├── examples/                        # 使用示例
├── docs/                            # 文档
└── tests/                           # 本地测试
```

## 指令生命周期

```text
学习页面流程 → 提取接口/参数 → 生成 command → verify → dry-run → 执行 → 验证业务结果 → 平台变化后更新
```

## 执行示例

单接口/单页面回退指令：

```bash
node src/cli.js execute --command demo.search_example --dry-run keyword=abc page=1
```

多步骤 workflow 指令：

```bash
node src/cli.js verify --command demo.workflow_example
node src/cli.js execute --command demo.workflow_example --dry-run keyword=abc limit=5
```

默认推荐先使用 `--dry-run`，确认参数、执行路径、步骤依赖、会话引用和风险等级后，再考虑真实执行。V3 第一阶段仍以结构化 dry-run 和协议接入为主，不做真实 UI 变更执行。

## 安装与分发

### 作为 MCP server 使用

```bash
npm install
node src/cli.js mcp
```

在支持 MCP 的 Agent 中，把 stdio server 配置为执行 `node /path/to/platform-command/src/cli.js mcp`。Agent 连接后可以发现：

- tools：list / describe / verify / execute；
- resources：`platform-command://commands`、`platform-command://distribution`；
- prompts：生成业务 command、安全执行 command。

### 作为通用框架扩展业务 command

公共 command 放在项目 `commands/*.json`。业务方可以任选一种方式扩展：

```bash
# 方式 1：在自己的目录维护 command 包
export PLATFORM_COMMANDS_DIR=/path/to/my-business-commands
node src/cli.js list --json

# 方式 2：CLI 临时指定
node src/cli.js list --json --commands-dir /path/to/my-business-commands
```

外部 command 与内置 command 同名时，外部 command 优先。`list --json` 会展示每个 command 的 source 与 package 信息，便于分发和排障。

### learn 的浏览器依赖策略

`playwright` 是 optional dependency。没有安装 Playwright 或浏览器时，learn 不再直接失败，而是生成 fallback 报告：

```bash
node src/cli.js learn --platform demo --action inspect --url https://example.com --provider manual
node src/cli.js learn --platform demo --action inspect --url https://example.com --provider http
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
