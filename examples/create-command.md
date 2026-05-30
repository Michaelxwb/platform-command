# 创建一个新的 command

command 是一个 JSON 文件，用来描述“某个平台上的一个业务动作”。

platform-command 默认自带 `commands/*.json` 公共 commands。业务方不需要改内置目录，可以把自己的 commands 放到外部目录，再用 `PLATFORM_COMMANDS_DIR` 或 `--commands-dir` 加载。

## 1. 从外部示例开始

仓库里提供了可复制示例：

```text
examples/external-commands/
├── crm.search_customer.json
└── order.refund_preview.json
```

复制一份到你的业务目录：

```bash
mkdir -p my-business-commands
cp examples/external-commands/crm.search_customer.json my-business-commands/crm.search_customer.json
```

## 2. 修改 command 基本信息

建议 `name` 与文件名一致：

```json
{
  "name": "crm.search_customer",
  "platform": "crm",
  "description": "按关键词搜索 CRM 客户。",
  "riskLevel": "low"
}
```

命名建议：

```text
<platform>.<action>
```

例如：

- `crm.search_customer`
- `order.refund_preview`
- `github.search_repositories`

## 3. 定义参数

`parameters` 描述用户执行时需要提供什么：

```json
{
  "parameters": {
    "keyword": {
      "type": "string",
      "required": true,
      "description": "客户名称、邮箱、手机号或客户编号。"
    },
    "limit": {
      "type": "number",
      "required": false,
      "default": 10,
      "description": "最多返回的客户数量。"
    }
  }
}
```

执行时传参：

```bash
node src/cli.js execute --commands-dir my-business-commands --command crm.search_customer --dry-run keyword=alice limit=5
```

## 4. 写 execution

### API-first command

适合“一个接口就能完成”的动作：

```json
{
  "execution": {
    "prefer": ["api", "ui"],
    "api": {
      "method": "GET",
      "url": "https://crm.example.com/api/customers/search?q={{keyword}}&limit={{limit}}",
      "headers": {
        "accept": "application/json"
      },
      "successWhen": [
        "HTTP status < 400",
        "response contains customers array"
      ]
    },
    "ui": {
      "url": "https://crm.example.com/customers",
      "steps": [
        { "action": "goto", "target": "https://crm.example.com/customers" },
        { "action": "fill", "target": "customer search input", "value": "{{keyword}}" },
        { "action": "click", "target": "search button" },
        { "action": "verify", "target": "customer result list is visible" }
      ]
    }
  }
}
```

### Workflow command

适合“多个步骤串联”的动作，例如先查订单，再生成退款预览，再打开后台确认：

```json
{
  "execution": {
    "prefer": ["workflow", "api"],
    "workflow": {
      "version": "2.0",
      "steps": [
        {
          "id": "get_order",
          "type": "api",
          "request": {
            "method": "GET",
            "url": "https://order.example.com/api/orders/{{params.orderId}}",
            "successWhen": ["status < 400"]
          },
          "extract": {
            "paidAmount": "$.paidAmount"
          }
        },
        {
          "id": "refund_preview",
          "type": "api",
          "dependsOn": ["get_order"],
          "request": {
            "method": "POST",
            "url": "https://order.example.com/api/refunds/preview",
            "body": {
              "orderId": "{{params.orderId}}",
              "paidAmount": "{{steps.get_order.paidAmount}}"
            },
            "successWhen": ["status < 400"]
          }
        }
      ]
    }
  }
}
```

## 5. 写成功标准和失败场景

不要只写“接口 200”或“按钮点击成功”，要写业务结果：

```json
{
  "successCriteria": [
    "搜索请求成功。",
    "返回或展示的客户列表与 keyword 相关。"
  ],
  "failureCases": [
    "CRM 登录态失效。",
    "keyword 为空或没有匹配客户。",
    "CRM API 或页面结构变化。"
  ]
}
```

## 6. 验证和 dry-run

先验证结构：

```bash
node src/cli.js verify --commands-dir my-business-commands --command crm.search_customer
```

再 dry-run：

```bash
node src/cli.js execute --commands-dir my-business-commands --command crm.search_customer --dry-run keyword=alice limit=5
```

也可以用环境变量加载：

```bash
PLATFORM_COMMANDS_DIR=my-business-commands node src/cli.js list --json
PLATFORM_COMMANDS_DIR=my-business-commands node src/cli.js verify --command crm.search_customer
PLATFORM_COMMANDS_DIR=my-business-commands node src/cli.js execute --command crm.search_customer --dry-run keyword=alice limit=5
```

## 7. 从 learn 产物生成 command

如果你先运行 learn：

```bash
node src/cli.js learn --platform crm --action search_customer --url https://crm.example.com/customers --provider manual
```

查看产物：

```text
runs/<时间>_crm_search_customer/learn_report.json
```

然后把观察到的接口、页面步骤、验证点填入 command JSON。

## 8. 安全提醒

- 默认先用 `--dry-run`。
- 不要把密码、私钥、原始 Cookie、Authorization 明文写进 command。
- 删除、支付、退款、权限变更、外部消息发送等动作建议标记为 `high`。
- 高风险 command 必须有明确确认和业务结果验证。
