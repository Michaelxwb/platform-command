# 在各 MCP agent 里安装 platform-command

`platform-command` 提供一个 **stdio MCP server**，任何支持 stdio MCP 的 agent 都能直接接入，调用 `platform_command_execute` 等工具按命令名执行平台操作。本文给各家 agent 的现成配置。

## 通用要点（所有 agent 一致）

- **启动命令**：`npx @jahanxu/platform-command mcp`
  全局装过（`npm i -g @jahanxu/platform-command`）则用 `platform-command mcp`。
- **环境变量 = 喂会话**：
  | 变量 | 作用 |
  |---|---|
  | `PLATFORM_COMMAND_USER_ID` | server-mode 用户标识，真实执行必需（如 `local`） |
  | `PLATFORM_COMMAND_STORAGE_STATE` | 指向登录态 storageState 文件（由[配套浏览器扩展](../browser-extension/README.md)导出） |
  | `PLATFORM_COMMAND_SITE`（可选） | 多实例选站，如 `cn` / `sea`，详见 [mss-report-commands.md](mss-report-commands.md) |
- **不配 env 也能装**：能列工具、能 dry-run；只有**导出/需登录态的命令真实执行**才依赖 `STORAGE_STATE`。
- **路径**：macOS/Linux `~/Downloads/platform-command/storage-state.json`；Windows `%USERPROFILE%\Downloads\platform-command\storage-state.json`（配置里用绝对路径）。

> 各家字段名略有差异（`env` vs `environment`、`command` 分/合），本质都是「跑 `npx @jahanxu/platform-command mcp` + 带上会话 env」。

---

## OpenCode

配 `opencode.json`（项目根）或全局 `~/.config/opencode/opencode.json`，`mcp` 键下：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "platform-command": {
      "type": "local",
      "command": ["npx", "@jahanxu/platform-command", "mcp"],
      "enabled": true,
      "environment": {
        "PLATFORM_COMMAND_USER_ID": "local",
        "PLATFORM_COMMAND_STORAGE_STATE": "/Users/<you>/Downloads/platform-command/storage-state.json"
      }
    }
  }
}
```
> 命令+参数合并成一个 `command` 数组；环境变量键是 `environment`。

## OpenClaw

CLI 一行加：
```bash
openclaw mcp add platform-command \
  --command npx \
  --arg @jahanxu/platform-command --arg mcp \
  --env PLATFORM_COMMAND_USER_ID=local \
  --env PLATFORM_COMMAND_STORAGE_STATE=$HOME/Downloads/platform-command/storage-state.json
```
或写进配置 `mcp.servers`：
```json
{
  "mcp": {
    "servers": {
      "platform-command": {
        "command": "npx",
        "args": ["@jahanxu/platform-command", "mcp"],
        "env": {
          "PLATFORM_COMMAND_USER_ID": "local",
          "PLATFORM_COMMAND_STORAGE_STATE": "/Users/<you>/Downloads/platform-command/storage-state.json"
        }
      }
    }
  }
}
```
验证：`openclaw mcp doctor platform-command --probe`（Web Control UI 有 `/mcp` 页可视化管理）。

## Hermes Agent（Nous Research）

编辑 `~/.hermes/config.yaml`，`mcp_servers` 键下：
```yaml
mcp_servers:
  platform-command:
    command: "npx"
    args: ["@jahanxu/platform-command", "mcp"]
    env:
      PLATFORM_COMMAND_USER_ID: "local"
      PLATFORM_COMMAND_STORAGE_STATE: "/Users/<you>/Downloads/platform-command/storage-state.json"
    enabled: true
    timeout: 120
```
> 启动时发现并把工具注册进 agent 工具表；支持 `include`/`exclude` 过滤要暴露的工具。

## Claude（Desktop / Code）/ Codex

通用 stdio MCP 写法（`command` + `args` + `env`）：
```json
{
  "mcpServers": {
    "platform-command": {
      "command": "npx",
      "args": ["@jahanxu/platform-command", "mcp"],
      "env": {
        "PLATFORM_COMMAND_USER_ID": "local",
        "PLATFORM_COMMAND_STORAGE_STATE": "/Users/<you>/Downloads/platform-command/storage-state.json"
      }
    }
  }
}
```
> Claude Code 也可 `claude mcp add`；配置文件位置见各自文档。

---

## GenericAgent（GA）：走 CLI，不用 MCP

GA 原生**不是 MCP 客户端**（9 个原子工具 + `code_run` 跑 shell，无 MCP 依赖）。它通过 `code_run` 直接调 **`pc-exec` / `platform-command` CLI**——这是容器内既有、已 working 的接法，对 GA 的极简设计最自然，无需引入 MCP。容器内规范见 [`deploy/ga/platform_command_sop.md`](../deploy/ga/platform_command_sop.md)。

```bash
pc-exec mss.export_weekly companyId=<ID>          # 真实执行（自动带 --execute-real --confirm）
pc-exec --dry mss.search_company keyword=<关键词>  # 预演
```

---

## 验证装好了没

任意 agent 接入后，先让它调一次只读/预演确认链路通：
- 列命令：`platform_command_list`
- 看某命令可执行性：`platform_command_describe { "command": "mss.export_report" }`
  返回 `execution.executable: true` 说明会话已就绪；`intercept_plan` 则是缺 `PLATFORM_COMMAND_STORAGE_STATE`。
- 预演执行：`platform_command_execute { "command": "mss.search_company", "params": { "companyName": "..." }, "dryRun": true }`

真实执行加 `"dryRun": false, "confirm": true`（等价 CLI 的 `--execute-real --confirm`）。
