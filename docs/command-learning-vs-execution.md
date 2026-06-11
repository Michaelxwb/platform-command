# 命令的"学习"与"执行"分离

> 架构决策记录。说明为什么自主学习新命令只在本地做、服务器容器只执行已审命令，
> 以及背后的技术约束。避免后来人重新论证"容器能不能自学命令"。

## 结论先行

| 阶段 | 在哪做 | 用什么 |
|------|--------|--------|
| **学命令（造）** | 本地（有桌面、真实浏览器） | Claude Code + kimi-webbridge 驱动真实 Chrome 自主探索 |
| **审 + 入库** | 人工 | 整理 signer/语义/风险等级 → 提交进 `commands/` → 重建镜像 |
| **用命令（执行）** | 服务器容器（headless 无人） | GA + platform-command（Playwright 适配器执行已审命令） |

容器**不做**自主学习命令。这不是能力缺失，是有意的边界。

## 两个阶段的本质区别

- **学命令**：需要一个能被 Agent 自由驱动、且带登录态的浏览器——Agent 开页面、点、读 DOM、
  抓网络请求，从轨迹里归纳出 API/选择器，结晶成 command 草案。这是**探索性、自由控制**的。
- **用命令**：执行一条已经定义好的 command（固定的 dataSource/UI 步骤），参数化运行。
  这是**受约束、可审计**的。

platform-command 框架本身解释执行 command（用命令）；学命令是产生 command 的上游环节。

## 为什么自主学习放在本地

### 1. kimi-webbridge 的设计前提是"真实桌面浏览器"

本地自主学习链路：

```
Claude Code ──> kimi-webbridge（daemon :10086 + 浏览器扩展）──> 真实 Chrome（已登录）
```

kimi-webbridge 由 **本地 daemon（监听 127.0.0.1:10086）+ 浏览器扩展** 组成：扩展通过
WebSocket 自动连 daemon，Agent 往 `:10086/command` 发 HTTP（navigate/click/evaluate…）即可
驱动浏览器。

> **更正（二次核实）**：早期本文档曾写"kimi-webbridge 必须 Kimi Desktop、不能 headless、
> 进不了容器"——经核实，**"其他 AI Agent"模式不需要 Kimi Desktop**（仅装扩展 + 在 Agent 里
> 粘贴一条 setup 指令，Agent 自动启动插件服务）；接入协议就是 curl `:10086/command`，无专有
> 协议；daemon 有 Linux 版（官方 install.sh 按架构安装）。因此 kimi-webbridge **技术上可以进
> 容器**，详见下方"附：kimi-webbridge 进容器方案"。

### 2. 它需要"带界面、能装扩展、有人/Agent 操作的浏览器"

kimi-webbridge 扩展要装进一个**真实/有界面的浏览器**（headless 旧模式装不了扩展），且需要
有人首次登录目标平台、装扩展。这与生产容器"headless、无人、轻量（每用户约 1.6% 内存，
浏览器按需起）"的定位冲突——**不是不能跑，而是定位不同**：kimi-webbridge 适合"有人值守的
学习工作台"，不适合"无人多用户的执行环境"。

### 3. Playwright 路线技术上可行，但本次不做

容器里其实具备自主学习的料：headless 浏览器（已有）、登录态 storageState（已有）、
GA 的浏览器控制原语 `TMWebDriver.execute_js`（对应 Playwright 的 `page.evaluate`）。
理论上可给 GA 的 TMWebDriver 加一个 Playwright 后端，让 GA 在容器内自主驱动登录态浏览器
（详见下方"未来如要支持"）。本次**主动不做**，原因是：

- 自主学习会让容器内 GA 拥有自由浏览器控制（任意 JS 执行），打破"容器只执行审过命令"
  的收敛安全模型；
- 学出的命令是草案，signer 逆向、参数语义、风险等级仍需人审，自学并不能省掉人这一环；
- 维持单一可信命令库（统一审、统一管）比"每个用户容器自己长命令"更可控、可审计。

## 一个学/用都绕不过的硬约束：签名

很多平台的请求带签名/加密参数（如 bilibili 的 wbi、`commands/bilibili/code/bilibili_wbi.js`）。
无论用 kimi-webbridge 还是 Playwright，浏览器侧只能观察到**签名后的值**，看不到**算法**——
要复现得人工逆向写 signer 代码。这是平台鉴权的客观存在，本地、容器同等难度，自动学习也迈不过，
必须人补。所以"学命令"永远是"半自动产出草案 + 人补关键逻辑"，不是"一句话出成品"。

## 实际工作流

```
本地：Claude Code + kimi-webbridge 自主探索目标平台
      → 抓 API/DOM、（必要时）逆向 signer
      → 整理成 commands/<platform>/cmd/*.json（+ code/ 下的 signer）
      → verify / execute --dry-run 验证
      → 提交进仓库命令库
            ↓ 重建镜像（build-image.sh），命令库只读打入
服务器容器：GA 用自然语言 → explain 匹配已审命令 → execute 执行
            （API 类走 Node fetch；UI/登录态类走 Playwright 适配器）
```

## 未来如要让容器支持自主学习

两条技术路径都已论证可行（本次均未实施）。**推荐分两类容器**：生产容器维持
headless 无人执行，单独搭一个"学习工作台"容器供有人值守地学命令。

```
学习工作台容器（有界面、能装扩展、VNC 远程操作）:
   人 VNC 进去 → 装扩展、登录平台 → GA 驱动浏览器自主学命令 → 产出 command
        ↓ 提交进仓库、重建生产镜像
生产容器（现在的 headless muad）:
   GA + Playwright 只执行审过的命令，无人、轻量、多用户
```

### 路线 A：kimi-webbridge 进容器（推荐做学习工作台）

复用本地同一套 kimi-webbridge，定位为"有人值守的学习工作台"。已核实可行，无 Kimi Desktop 依赖。

1. **基础镜像**用带界面 + 远程访问的浏览器镜像（不是 headless）。候选（按推荐序）：
   - `kasmweb/chrome`（真 Google Chrome，扩展兼容性最稳，KasmVNC 网页访问）
   - `linuxserver/chromium`（更轻，KasmVNC，已在用户 NAS 上，适合先验证）
   - `accetto/ubuntu-vnc-xfce-chromium`（完整桌面，最灵活但最重）
   - ❌ 排除 `browserless`/`zenika/alpine-chrome` 等 headless 服务型——无法交互装扩展。
2. 容器内装 **Linux 版 kimi-webbridge daemon**（`curl -fsSL <官方install.sh> | bash`，
   按架构装；本地的 macOS arm64 二进制不能直接拷）。
3. VNC 进容器 → 在 Chrome 里装 kimi-webbridge 扩展（商店或 unpacked）→ 扩展 WS 自动连
   daemon（`status` 显示 `extension_connected:true`）→ VNC 登录目标平台。
4. GA 接入：协议就是 `curl -X POST 127.0.0.1:10086/command -d '{"action":...}'`，GA 用
   `code_run` 即可；在 GA 的 SOP/memory 写明"浏览器操作走 :10086 + action 列表"。
5. 每用户浏览器 profile 持久化（登录态）；首次登录需人工。

**镜像/资源代价**：相比 headless（约 2.83GB / 每用户空载 ~30MB），带界面 Chrome+VNC 镜像
约 +0.5~1GB，且 Chrome+VNC **常驻**，每实例内存几百 MB 起。所以只适合少数"学习"实例，
不适合规模化生产。**唯一仍待实测的点**：扩展能否在容器 Chrome 里离线/稳定加载并自动连
（KasmVNC 类镜像可手动装，绕过此问题）。

### 路线 B：GA + Playwright 后端（更轻，纯程序化）

不依赖扩展，让 GA 直接用 Playwright 驱动 headless 登录态浏览器：

1. 给 GA fork 的 `TMWebDriver` 加 **Playwright 后端**：`execute_js(script)` 路由到
   `page.evaluate("async () => { <script> }")`（GA 脚本是函数体风格，用 `return`、可能 `async`，
   必须这样包），`get_all_sessions`/`get_session_dict` 报告 Playwright page 为 session，
   自动建一个 page 绕开"无 tab"分支。注意 Python Playwright 是 sync API + GA 多线程，
   需专属浏览器线程 + 队列解耦。
2. 镜像 GA venv 装 `playwright`，复用基础镜像浏览器二进制（`PLAYWRIGHT_BROWSERS_PATH`）。
3. entrypoint 注入 storageState 路径 + 启用 Playwright 后端；放开 SOP 的浏览器工具约束。
4. 安全权衡：容器内 GA 获得自由浏览器控制（仅限自己用户的容器/登录态，不跨用户）。

**对比**：路线 A 复用 kimi-webbridge 整套、能 VNC 人工介入（适合需要人辅助的学习），但重、要装扩展；
路线 B 最轻、纯 headless 程序化，但要改 GA 的 TMWebDriver。两者 GA 侧都要接一个浏览器控制通道。

### 不变的硬约束

无论哪条路线，**签名逆向**（见上文）仍需人补——浏览器侧只能看到签名值，看不到算法。

## 相关

- 多用户部署：`deploy/ADMIN_GUIDE.md`
- 安全边界：`docs/safety.md`
- 服务器模式约束：`.code-flow/specs/backend/platform-rules.md`
