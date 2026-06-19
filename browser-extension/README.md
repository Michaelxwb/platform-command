# platform-command session exporter

监控配置域名的 Cookie，自动导出为 platform-command 可用的 **Playwright storageState**，覆盖写入固定文件。
配合 platform-command 的 MCP/CLI：调用任意命令时框架按目标 host 自动挑对应平台的 cookie 执行，无需手动导会话。

## 安装

1. Chrome → `chrome://extensions` → 开「开发者模式」→「加载已解压的扩展程序」→ 选本目录
   （`browser-extension/`；npm 安装的话在 `node_modules/@jahanxu/platform-command/browser-extension/`）。
2. **点工具栏的扩展图标**，直接弹出配置面板（无需进设置页）：
   - **运行状态 / 最近导出**：显示监控域数、上次导出时间与 cookie 数、输出路径。
   - **监控域名**（每行一个 host）：仅这些域名的 cookie 变化才触发导出。
   - **输出文件名**：默认 `platform-command/storage-state.json`（相对 Downloads）。
   - **保存** / **立即导出**：保存配置；立即导出一次用于验证。

## 接到 platform-command

导出文件落在**各系统的下载目录**下（扩展用 Chrome downloads，`/` 会自动转成系统分隔符，跨平台一致）：
- macOS / Linux：`~/Downloads/platform-command/storage-state.json`
- Windows：`C:\Users\<你>\Downloads\platform-command\storage-state.json`

把 MCP server（或 CLI）所在进程的环境变量指向该文件：

```bash
# macOS / Linux
export PLATFORM_COMMAND_USER_ID=local
export PLATFORM_COMMAND_STORAGE_STATE="$HOME/Downloads/platform-command/storage-state.json"
```
```powershell
# Windows (PowerShell)
$env:PLATFORM_COMMAND_USER_ID = "local"
$env:PLATFORM_COMMAND_STORAGE_STATE = "$env:USERPROFILE\Downloads\platform-command\storage-state.json"
```
> 在 MCP 客户端里更常见的是写进该 server 配置的 `env` 字段（用上面的绝对路径）。

之后在浏览器登录目标平台 → 扩展自动把会话写进该文件 → MCP 里调 `mss.*` 等命令即真实执行。

## ⚠️ 关键：域名必须与命令请求的 host 一致

框架按命令的目标 host 过滤 cookie（`host === cookieDomain || host.endsWith('.'+cookieDomain)`）。
所以**这里配的域名要跟命令实际请求的 host 对得上**。例如命令打 `soar.sea.sangfor.com`，
就必须监控含该 host 的 cookie 域；只监控 `soar.sangfor.com.cn` 不会被命令命中。

> **多站点（国内/海外）**：若命令包用 `config/sites.json` 配了多个实例（如 soar 的 `sea`/`cn`），
> 把这些实例的 host **都加进监控域名**，登录哪套就导哪套；命令侧用 `site=cn` 或
> `PLATFORM_COMMAND_SITE` 选实例，框架自动取对应 host 的 cookie。见 `docs/mss-report-commands.md`。

## 行为说明

- **多平台共存**：配多个域名时合并成一份 storageState，框架按 host 自动分流，互不串味。
- **httpOnly**：用 `chrome.cookies.getAll` 读取，能拿到 `soc-token`/`csrf_token` 等 httpOnly cookie（`document.cookie` 拿不到）。
- **去重**：内容指纹未变不重复下载；变了才覆盖。
- **触发**：白名单域名 cookie 变化即导（防抖 500ms）+ 每分钟兜底重扫 + 弹窗「立即导出」。
