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
│   ├── execute.js                   # 指令执行 / dry-run
│   ├── learn.js                     # 页面学习与请求捕获
│   ├── utils.js                     # 通用工具函数
│   └── verify.js                    # command 结构校验
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

```bash
node src/cli.js execute --command demo.search_example --dry-run keyword=abc page=1
```

默认推荐先使用 `--dry-run`，确认参数、执行路径和风险等级后，再考虑真实执行。

## 学习示例

```bash
node src/cli.js learn --platform demo --action inspect_example --url https://example.com --observe-seconds 5
```

执行后会在 `runs/` 目录下生成带时间戳的学习报告，例如：

```text
runs/<时间>_<平台>_<动作>/learn_report.json
```

报告中会记录页面标题、访问地址、捕获到的请求元信息等内容。默认不会保存密钥、明文 Cookie 或 Authorization 明文。

## 当前版本能力

当前第一版提供：

- skill 项目骨架
- CLI 入口
- 页面学习模式
- 请求元信息捕获
- command 模板
- command 结构校验
- dry-run 执行计划输出
- 示例 command
- 本地测试

真实平台的稳定指令需要在访问具体平台并观察实际操作后生成。

## 安全原则

- 默认使用 dry-run，避免误操作。
- 不保存密码、私钥、原始 Cookie、原始 Authorization 等敏感信息。
- 删除、支付、退款、批量修改、权限变更、外部消息发送等动作视为高风险。
- 高风险动作必须显式确认。
- 成功不能只看按钮是否点击或接口是否返回 200，必须验证业务结果是否符合预期。
