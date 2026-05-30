# 外部 commands 示例

这个目录模拟业务方自己的 command 包。实际项目中，你可以把这些 JSON 放到任意独立目录或独立 Git 仓库，然后通过 `PLATFORM_COMMANDS_DIR` 或 `--commands-dir` 加载。

## 文件命名

建议文件名与 command name 一致：

```text
<platform>.<action>.json
```

例如：

```text
crm.search_customer.json
order.refund_preview.json
```

## 运行示例

在 platform-command 项目根目录执行：

```bash
PLATFORM_COMMANDS_DIR=examples/external-commands node src/cli.js list --json
PLATFORM_COMMANDS_DIR=examples/external-commands node src/cli.js verify --command crm.search_customer
PLATFORM_COMMANDS_DIR=examples/external-commands node src/cli.js execute --command crm.search_customer --dry-run keyword=alice limit=5
```

显式传参也可以：

```bash
node src/cli.js verify --commands-dir examples/external-commands --command order.refund_preview
node src/cli.js execute --commands-dir examples/external-commands --command order.refund_preview --dry-run orderId=ORD-10001 reason=customer_request
```

## 最小结构

一个 command 至少应包含：

- `name`：全局唯一命令名，推荐 `<平台>.<动作>`。
- `platform`：平台名。
- `description`：业务结果说明。
- `riskLevel`：`low` / `medium` / `high`。
- `parameters`：用户需要传入的业务参数。
- `execution`：执行计划，可包含 `api`、`ui` 或 `workflow`。
- `successCriteria`：成功标准，不能只写“点击成功”。
- `failureCases`：常见失败原因。

## 注意

示例里的域名是 `*.example.com`，用于说明结构，默认只建议 `--dry-run`。接入真实业务时，把 URL、参数、验证条件替换成你自己的系统。
