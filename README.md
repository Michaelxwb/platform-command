# platform-command

`platform-command` 是一个轻量级 skill 项目，用于学习平台页面上的操作流程，捕获接口与页面结构，提取可变参数，并把重复的平台操作沉淀成可复用的指令。

它的目标不是构建一个庞大的自动化平台，而是尽量复用当前 agent 已具备的浏览器控制、网络监听、文件读写和验证能力，让 agent 能够在真实平台上逐步学习并形成稳定指令。

## 快速开始

```bash
npm install
node src/cli.js --help
node src/cli.js verify --command demo.search_example
node src/cli.js execute --command demo.search_example --dry-run keyword=abc
npm test
```

## 目录结构

```text
platform-command/
├── SKILL.md                         # skill 能力说明
├── README.md                        # 项目说明
├── package.json                     # Node.js 项目配置
├── src/                             # CLI 与核心逻辑
│   ├── cli.js                       # 命令行入口
│   ├── command_store.js             # command 读取与列表
│   ├── execute.js                   # 指令执行 / workflow dry-run
│   ├── learn.js                     # 浏览器页面学习、DOM 摘要、请求捕获、操作轨迹
│   ├── workflow.js                  # V2 多步骤 API/UI workflow 计划生成
│   ├── session.js                   # 安全会话引用说明
│   ├── utils.js                     # 通用工具函数
│   └── verify.js                    # command / workflow 结构校验
├── commands/                        # 已学习或手工整理的指令
├── platforms/                       # 平台资料与约束
├── runs/                            # learn 执行产物
├── templates/                       # 模板文件
├── examples/                        # 使用示例
├── docs/                            # 安全文档等说明
└── tests/                           # 本地测试
```

## 指令生命周期

```text
学习页面流程 → 提取接口/参数 → 生成 command → dry-run → 执行 → 验证业务结果 → 平台变化后更新
```

## 执行示例

单接口/单页面回退指令：

```bash
node src/cli.js execute --command demo.search_example --dry-run keyword=abc page=1
```

V2 多接口 + UI workflow 指令：

```bash
node src/cli.js verify --command demo.workflow_example
node src/cli.js execute --command demo.workflow_example --dry-run keyword=abc limit=5
```

默认推荐先使用 `--dry-run`，确认参数、执行路径、步骤依赖、会话引用和风险等级后，再考虑真实执行。V2 当前只启用结构化 dry-run，不直接做真实变更。

## 学习示例

```bash
node src/cli.js learn --platform demo --action inspect_example --url https://example.com --observe-seconds 5
```

执行后会在 `runs/` 目录下生成带时间戳的学习报告，例如：

```text
runs/<时间>_<平台>_<动作>/learn_report.json
```

报告中会记录页面标题、访问地址、DOM 摘要、候选参数、捕获到的请求元信息、响应元信息和用户操作轨迹。默认不会保存密钥、明文 Cookie 或 Authorization 明文。

## V2 当前能力

当前 V2 提供：

- skill 项目骨架与 CLI 入口；
- 浏览器辅助 learn：打开页面、记录 DOM 摘要、输入框/按钮/链接/表单、网络请求/响应元信息、基础操作轨迹；
- 自动生成候选参数与 suggestedWorkflow 草案；
- 多步骤 workflow command：支持 api / ui / manual step、dependsOn、retry、extract、successWhen；
- UI workflow dry-run 动作：goto、fill、click、select、waitFor、assert、screenshot；
- sessionRef 安全会话引用：只记录“使用哪个浏览器 profile/安全存储引用”，不保存 Cookie、Authorization、密码、密钥明文；
- command 模板与 V2 示例 command；
- command / workflow 结构校验；
- 本地测试与 dry-run 验收。

真实平台的稳定指令需要在访问具体平台并观察实际操作后生成，并通过业务结果验证持续校准。

## 安全原则

- 默认使用 dry-run，避免误操作。
- 不保存密码、私钥、原始 Cookie、原始 Authorization 等敏感信息。
- 删除、支付、退款、批量修改、权限变更、外部消息发送等动作视为高风险。
- 高风险动作必须显式确认。
- 成功不能只看按钮是否点击或接口是否返回 200，必须验证业务结果是否符合预期。
