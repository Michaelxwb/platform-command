# SOP：容器环境内的平台操作规范

你运行在一个 headless 服务器容器内，环境与桌面不同，遵守以下规则：

## 平台操作统一走 platform-command

对目标平台（查询数据、导出报表、执行平台动作）的所有操作，使用 `platform-command` CLI，不要自己写 HTTP 请求或尝试浏览器操作。

### 首选：用 pc-exec（防呆包装，拼不错）

```bash
pc-exec <command> key=value key=value ...        # 真实执行（自动带 --execute-real --confirm）
pc-exec --dry <command> key=value ...            # 仅预演
```
例：`pc-exec zhihu.list_comments resourceType=answers resourceId=123 outputPath=/data/platform/output/x.xlsx`

pc-exec 已处理好执行标志，你只管给命令名 + 裸 key=value 参数。**优先用它**。

### 原生 CLI（了解即可，pc-exec 内部就是调它）

```bash
platform-command list --json                 # 看有哪些命令
platform-command explain "<自然语言需求>"     # 自然语言匹配命令
platform-command describe --command <name>   # 看参数、风险等级、就绪状态
platform-command execute --command <name> --execute-real --confirm key=value  # 真实执行
```

### ⚠️ 调用铁律（违反必然失败，别试错）

- **参数格式只有一种**：裸 `key=value`。**不要**加 `--` 前缀、**不要** `--param key=value`、**不要** `--json '{...}'`。
- **真实执行必须 `--execute-real --confirm` 二者同时给**。**没有** `--approve` / `--live` / `--run` 这些参数——别发明。只给 `--confirm` 会停在 dry-run。
- 返回里有 `"status": "dry_run"` 就是**没真执行**（响应的 `note`/`realRunHint` 会告诉你怎么真跑）；用 pc-exec（不加 --dry）就是真执行。
- 报错信息里通常**直接附带了正确调用示例**——照着改，不要在错误参数上反复试错，更不要转去自写脚本。
- 命令返回"登录态已失效"时，把重新导入登录态的指引原样转告用户，不要重试。

## 铁律：有 command 的领域，禁止自己代偿

判断顺序：接到平台操作请求，**先 `platform-command list` / `explain` 看有没有匹配的 command**。

- **有匹配 command（或该平台已有任意 command）→ 只能走 platform-command。**
  执行失败、不可执行、被阻塞、报错——**一律停下，把失败原因和命令输出原样报告用户，等待指示**。
  **严禁**用 Python requests、playwright 脚本、curl 等任何方式"自己想办法"完成它——
  那会绕过审计记录、验收契约和风险确认门，是严重违规。命令做不了就是做不了，由人决定下一步。
- **没有任何匹配 command 的领域 → 你可以自由发挥**（写脚本、用 headless Chromium 等）。
  这类领域不在 platform-command 覆盖范围内，按下方工具能力自行处理。

> 例：post_comment 这类命令报"不可执行/需要登录态"时，报告用户即可，不要自己写 playwright 去发评论。

## 本环境不可用的工具

以下工具在容器内没有载体，**不要尝试使用**，失败后也不要反复重试：

- 浏览器注入 / TMWebDriver（无真实桌面浏览器）
- 键盘鼠标控制、屏幕视觉（无显示器）
- ADB（无移动设备）

## 可用：headless Chromium（仅限匿名浏览类任务）

容器内有 headless Chromium 和 node 版 playwright，可用于**截图、查看公开网页**这类临时任务：

```bash
NODE_PATH=$(npm root -g) node -e '
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto("https://example.com", { waitUntil: "domcontentloaded" });
  await p.screenshot({ path: "/data/platform/output/shot.png", fullPage: false });
  await b.close();
})()'
```

**硬边界，不可越过**：
- 截图/输出一律写到 `/data/platform/output/` 下；
- **禁止读取 `/secrets/` 下的任何文件**（登录态只能由 platform-command 适配器使用）；
- 凡是 platform-command 已覆盖的平台操作（见上方"铁律"），**必须走 platform-command**，失败也不准用脚本代偿；headless Chromium 只用于无 command 覆盖的匿名浏览/截图。

## 文件路径约定

- 导出/输出文件写到 `/data/platform/output/` 下（其他路径会被沙箱拒绝）。
