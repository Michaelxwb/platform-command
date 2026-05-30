# platform-command skill

## 目标

`platform-command` 用于把平台上的重复操作抽象成可复用指令。它帮助 agent 自主学习目标平台动作，观察页面元素，捕获网络请求，推断参数，生成 command 模板，执行已学习指令，并验证最终业务结果。

这个 skill 的核心价值是：

1. 从真实页面操作中学习流程。
2. 识别哪些字段应该成为指令参数。
3. 发现接口调用与页面动作之间的对应关系。
4. 优先使用接口执行，必要时回退到 UI 操作。
5. 用业务结果验证操作是否真的成功。

## 核心模式

### 1. learn：学习动作

学习一个新的平台动作。

```bash
node src/cli.js learn --platform demo --action search_example --url https://example.com --observe-seconds 10
```

learn 模式应该完成：

- 打开目标页面；
- 观察 DOM 结构；
- 捕获网络请求与响应元信息；
- 识别表单、按钮、输入框、表格、成功提示、错误提示；
- 在 `runs/` 目录下写入学习报告；
- 生成候选参数和 suggestedWorkflow 草案，供后续整理成 command。

安全要求：learn 模式以观察为先。除非用户明确允许测试提交，否则不能主动执行破坏性提交。

### 2. extract_api：提取接口

从一次 learn 结果中提取并总结候选接口。

当前版本会把捕获到的请求元信息、响应元信息和候选 API 步骤保存到学习报告中。稳定接口可以提升为 command 模板中的 api step，并通过 dependsOn / extract 串联多个接口。

### 3. generate_command：生成指令

在 `commands/` 目录下生成或更新 command 模板。

一个 command 模板应描述：

- 指令名称；
- 所属平台；
- 风险等级；
- 参数、默认值和校验提示；
- 推荐执行路径：优先 API，必要时 UI 回退；
- 多步骤 workflow：api / ui / manual step、dependsOn、retry、extract、successWhen；
- UI 动作序列：goto、fill、click、select、waitFor、assert、screenshot；
- sessionRef：只保存浏览器 profile 或安全凭据引用，不保存密钥明文；
- 成功标准；
- 常见失败场景。

### 4. execute：执行指令

执行一个已学习的 command。

```bash
node src/cli.js execute --command demo.search_example --dry-run keyword=abc
```

默认规则：

- dry-run 是安全模式，只输出执行计划，不做真实变更；
- 当 API 元信息完整时，优先使用 API 执行；
- 多个接口可按 workflow 顺序组合，后续步骤可引用前序步骤 extract 的结果；
- API 不可用或风险较高时，可回退到 UI workflow；
- V2 当前实现只输出结构化 dry-run 计划，真实执行引擎默认关闭；
- 高风险 command 必须显式确认后才能真实执行。

### 5. verify：验证指令

验证 command 模板结构是否有效。

```bash
node src/cli.js verify --command demo.search_example
```

verify 至少应检查：

- 必填字段是否存在；
- 参数定义是否合理；
- 风险等级是否声明；
- 执行计划是否存在；
- 成功标准是否存在；
- workflow 步骤 id 是否唯一，api step 是否有 request，ui step 是否有动作序列；
- UI 动作是否属于支持集合。


### 6. MCP：跨 Agent 接入

V3 推荐把 platform-command 作为 MCP server 接入不同 Agent。MCP 暴露：

- tools：列出、描述、验证、执行 command；
- resources：读取 command catalog 和分发说明；
- prompts：指导 Agent 生成业务 command 或安全执行 command。

启动方式：

```bash
node src/cli.js mcp
```

支持 skill 的 Agent 仍可读取本文件作为能力说明；支持 MCP 的 Agent 优先走 MCP。

### 7. learn fallback：降低浏览器依赖

learn 优先使用 Playwright 做浏览器观察；如果 Playwright 或浏览器不可用，可以回退：

```bash
node src/cli.js learn --platform demo --action inspect --url https://example.com --provider http
node src/cli.js learn --platform demo --action inspect --url https://example.com --provider manual
```

HTTP fallback 会抓取页面标题、响应元信息和文本预览；manual fallback 会生成需要宿主 Agent/用户补充的 command 骨架。这样即使某些 Agent 没有强浏览器控制能力，也能产出可继续编辑的学习报告。

## 安全规则

- 禁止把密码、私钥、原始 Cookie、原始 Authorization Header 写入 command 文件。
- 默认只记录 token 字段名、来源和用途，不记录明文值。
- 未知动作和高风险动作默认 dry-run。
- 删除、支付、退款、批量更新、权限变更、外部消息发送等动作一律视为高风险。
- 成功必须以业务结果验证为准，而不是只看按钮点击成功或接口返回成功。

## 结果原则

每个 command 最终都应该能回答：

1. 使用了哪些参数？
2. 实际走的是 API 路径还是 UI 路径？
3. 有什么证据证明业务结果成功？
4. 如果失败，失败发生在哪一步，原因是什么？
