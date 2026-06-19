# MSS 海外报告命令集

由 `mss-report-skill`（Claude Skill + Python）转换为 platform-command 框架原生命令。Agent 通过自然语言调用；命令默认 dry-run，真实执行需 `--execute-real --confirm`。

## 总流程（agent 编排：一句请求 → 自动登录 → 执行）

登录与命令在机制上是两块（登录=真浏览器+对话框给码，不能做成命令；命令=吃 storageState），但**用户不该感到割裂**——由 agent 把"按需登录"收进每个请求的前置步骤。用户全程只看到：自己的请求 + （仅首次/会话过期时）"请发我验证码" + 结果。

任何 MSS 请求（导出/发邮/查配置…）agent 都按这个决策流编排：

```
1. 自检会话：node dist/src/entry/cli.js session status
     ready=false（或后续命令返回 401/403）→ 取会话（见【登录】节）：
        首选方式一：让用户自己登录浏览器 → 取完整 Cookie → session import-cookie
        备选方式二：agent 驱动登录 + 对话框要验证码
     → 设 PLATFORM_COMMAND_USER_ID / STORAGE_STATE
2. 解析参数：客户名→companyId 用 mss.search_company；模板用 mss.get_template；范围/小语种用 display_config/get_locale
3. 执行目标命令（--execute-real --confirm）：export_weekly/monthly（一键导出+同步）、send_email、download_report 等
     - 非导出（搜客户/查状态/发邮件/同步/配置/下载）→ node fetch+cookie 或 kimi-webbridge
     - 导出 → interceptFlow（Playwright 开导出页 + 改写 export_locales + 抓/兜底 task_id + 轮询 report_status）
```

→ **登录不是用户单独要做的事，是 agent 在需要时自动补的前置条件。** 会话 ~6h 有效，期间所有请求直接执行、无需再登。详见下方「登录」与各命令。

## 鉴权与运行环境

所有调 soar 的命令用 `runtime.auth.type=browser_session_cookie` 复用登录态。框架按环境自动选适配器——**一套代码、一套配置**：
- **非导出（http_json）**：有 storageState → node fetch 注入 Cookie 头（Plan B，直连 soar）；无 storageState → kimi-webbridge 连真实浏览器代发。
- **导出（interceptFlow）**：Playwright 开导出页 + `page.route` 改写 `export_locales` + 抓 `generate_report` 的 task_id + 轮询 `report_status`。
- 请求头 `X-Csrftoken` 取自 `csrf_token` cookie（`{{session.csrfToken}}`）。401/403 或非 0 code 刷新登录态，命令不自动重试。

> **一套代码、一套配置，两种部署环境（差异仅"补 chromium"一项）：**
> - **生产**：Docker 容器（headless），镜像自带 chromium，全自动（含 daemon 定时导出）。
> - **调试沙箱**：本身直连 soar（**无需代理**）。沙箱缺 bundled chromium——**手动补一次**：把 Playwright 标准 chromium 拷进共享项目目录、设 `PLAYWRIGHT_BROWSERS_PATH`（见「导出在沙箱」）。除此之外，命令/配置/代码与生产完全一致。

## 命令清单（19）

### 只读（return_json）
| 命令 | 说明 |
|---|---|
| `mss.search_company keyword= [limit=]` | 模糊搜客户 → companyId/companyName（分页） |
| `mss.report_status [keyword= limit= startTime= endTime=]` | 报告任务列表/状态 |
| `mss.get_locale companyId=` | 客户小语种配置（local_locale） |
| `mss.get_template` | 周/月报模板 id/name |
| `mss.query_email_content taskId= companyId=` | 邮件话术（主题/正文各部分）预览 |

### 写 / 接口
| 命令 | 说明 |
|---|---|
| `mss.set_locale companyId= locale=` | 改小语种（GET→清洗 logo+module_list 兜底→MODIFY） |
| `mss.send_email taskId= companyId= reportType= recipient= [cc= bcc=]` | 发报告邮件（多接口拼 payload） |
| `mss.sync_portal taskId= [reportType= reportVersion=]` | 同步报告到 portal |

### 配置（本地 store，自动初始化）
| 命令 | 说明 |
|---|---|
| `mss.display_config companyId=` | 查看客户配置（缺失自动初始化默认值） |
| `mss.update_config companyId= config=<obj>` | 修改范围/检查/发邮/同步开关 |
| `mss.update_email companyId= emails=<obj>` | 维护邮箱 delta（唯一邮箱入口） |
| `mss.set_schedule companyId= schedule=<obj>` | 设置/取消周/月报定时 |

### 导出与业务组合
| 命令 | 说明 |
|---|---|
| `mss.export_report companyId= reportType= templateId= templateName= rangeType= exportConfigKey= [locale=]` | 单步导出（interceptFlow：改写 export_locales + 抓 task_id + 轮询；抓不到走 report_status 快照差集兜底） |
| `mss.download_report taskId= [outputPath=]` | 下载已生成报告文件（`GET report_download?task_id`，二进制落地；纯 node） |
| `mss.export_weekly companyId=` | 周报组合：配置→模板→小语种→导出→（按开关）同步；可 daemon 定时 |
| `mss.export_monthly companyId=` | 月报组合（同上） |
| `mss.export_all_configs [keyword= outputPath=]` | 批量汇总客户配置 → Excel |

## 登录态（所有命令必需）

所有调 soar 的命令吃同一份登录态 = storageState（等价 skill 的 cookies.txt）：非导出经 node fetch 注入 Cookie 头，导出经 Playwright 注入同一会话。**优先方式一 import-cookie**。框架提供平台无关的 `session` 子命令：

```bash
# 方式一：用已登录浏览器的 Cookie 串（DevTools→Network→请求头 Cookie 复制整串）
node dist/src/entry/cli.js session import-cookie --host soar.sea.sangfor.com --cookie "<cookie整串>"
# 方式二：headed 浏览器登录后保存（需 playwright）
node dist/src/entry/cli.js session login --url https://soar.sea.sangfor.com
# 自检
node dist/src/entry/cli.js session status

# 然后设置两个环境变量（import-cookie 输出会提示路径），导出即可用
export PLATFORM_COMMAND_USER_ID=local
export PLATFORM_COMMAND_STORAGE_STATE=$PWD/.platform-command/storage-state.json
```

> 所有命令统一吃 storageState：非导出 node fetch 带 Cookie 头直连 soar；导出 Playwright 用同一 storageState。沙箱里 import-cookie 最稳（不碰验证码自动化）。

### 登录（agent 编排，验证码走对话框）

获取登录态有两种方式，**优先方式一**（最稳、不碰验证码/选择器自动化）：

### 方式一（推荐）：你手动登录 → agent 取会话

1. 你在自己浏览器登录 `https://soar.sea.sangfor.com`（验证码/2FA 你自己点，最自然）
2. 告诉 agent「已登录」
3. agent 取 soar 的完整 Cookie（含 httpOnly）：
   - 有 cookie 读取能力的浏览器工具（chrome-mcp/CDP 等）→ agent 自动读 cookie jar 或抓一个 soar 请求的 `Cookie` 头；
   - 没有 → 你从 DevTools（Network → 任一 soar 请求 → Request Headers → Cookie）复制整串发给 agent（一次性，**环境无关、不依赖 webbridge**）。
4. `node dist/src/entry/cli.js session import-cookie --host soar.sea.sangfor.com --cookie "<整串>"`
5. 设 `PLATFORM_COMMAND_USER_ID` / `PLATFORM_COMMAND_STORAGE_STATE`（import 输出会提示路径）→ `session status` 应 ready:true → 直接导出。

> 关键：人登录（含验证码）最自然、零自动化脆点；agent 只把会话搬进 storageState。会话 ~6h，期间所有命令直接跑。

### 方式二（备选，无人值守）：agent 驱动登录

仅当需要全自动、无人给码时用。**不做成一次性命令**：验证码点"发码"后才发、由用户在对话框给——运行中的 CLI 命令等不了对话来回。所以由 **agent 用实时浏览器工具逐步驱动**，发码处暂停、对话框要码。照做指令（选择器来自 learn 实测，脆在 class 选择器/验证码）：

```
【MSS 登录 — agent 照做】
前提：你有实时浏览器工具（kimi-webbridge / chrome-mcp / Playwright MCP）。

1. 打开 https://soar.sea.sangfor.com/ui-base/login.html
2. input[name=username] 填账号，input[type=password] 填密码
   → 点 button.uedc-ppkg-login_product-submit（找不到就点文字含 "Log In" 的按钮）
3. 等验证界面，点 span.email-code__button 发邮箱验证码（短信则 span.sms-code__button）
4. ⏸ 在对话框对用户说"验证码已发到邮箱，请把验证码发我"，等用户回码
5. 用户给码后，填 input.email-code__input（或 input[name=captcha]）= 该码
   → 再点 button.uedc-ppkg-login_product-submit
6. 确认成功：URL 变为 /index.html#/（或 /#/risk/event），或页面标题含 "Incidents"
7. 取当前浏览器对 soar.sea.sangfor.com 的完整 Cookie（含 httpOnly），执行：
   node dist/src/entry/cli.js session import-cookie --host soar.sea.sangfor.com --cookie "<整串>"
8. 按上一步输出的 path 设环境变量：
   export PLATFORM_COMMAND_USER_ID=local
   export PLATFORM_COMMAND_STORAGE_STATE=<path>
   再 node dist/src/entry/cli.js session status 应 ready:true
→ 之后导出/发邮件等全自动，~6h 后重登一次。

提示：选择器只是起点；若某个匹配不到，按语义定位（按 placeholder/label/按钮文字找对应元素）。
```

补充（learn 实测）：
- SMS 备选：发码 `span.sms-code__button`、输入 `input.sms-code__input`（邮箱/短信二选一）。
- 成功判定（任一）：URL 含 `/index.html` 或 `/#/risk/event`；存在 cookie `csrf_token`；页面标题含 `Incidents`。
- 验证码有效期 ~60s、只能用一次；登录后 `csrf_token` ~6h，后续 API 用 `X-Csrftoken: <csrf_token>`。

**选择器稳定性**：只有登录用 CSS 选择器，其余命令（搜客户/发邮件/导出等）走 HTTP 接口/JSON 字段，**不受前端改版影响**。登录里 `input[name=username]`/`[type=password]` 等属性选择器较稳；`button.uedc-ppkg-login_product-submit`、`*.email-code__*` 等 class 选择器在前端改版/组件库升级时**可能变**——但登录是 agent 现场适配（按语义兜底）+ 可重新 learn，代价低。

> 不要把上面流程打包成 `mss.login` 命令——一次性命令过不了"对话框等码"这一步。learn 产出的 `commands/mss/cmd/login.json` 已确认不可执行（走 ui_intercept 忽略登录步骤、引用缺失的 login_url.js、验证码当预传参数），已删除；选择器知识全部并入本手册。

## 导出（interceptFlow：一套代码，生产/沙箱同源）

导出含**重前端处理**（前端串多接口取数 + 客户端聚合算 send_content/excel + 渲染），只有真浏览器能跑。interceptFlow 用 Playwright 驱动 chromium 完成全链，与 skill 同源：

```
① 算时间范围拼导出 URL（report_edit.html#/...&generate_type=auto）
② Playwright 开页：page.route 改写 get_history_pwd 的 export_locales（注入小语种）
③ SPA 自动跑生成链 + 前端处理 → POST generate_report
④ 抓 generate_report 响应取 task_id；抓不到 → report_status「触发前快照差集 + task_status==1」兜底锁定刚生成那条
⑤ 轮询 report_status 至 task_status==1（≤30min，RULE-07）
```

`export_weekly/monthly` 在此之上组合：配置→模板→小语种→导出→（按开关）发邮件/同步；可由 daemon 定时全自动。

**小语种零降级（前端 i18n）**：翻译/图片是前端静态资源（`/ui-report/static/remote/<code>/`，code=`th/id/de/it`…），SPA 按 `export_locales` 加载渲染。interceptFlow 的 `page.route` 改写 `get_history_pwd` 响应的 `export_locales=[en,<code>]`（`export_locales.js`）即注入小语种——**无后端 API，靠拦截**。`mss.set_locale` 设的是 `local_locale`（客户报告语种配置），与导出语种是两回事。

**抓不到 task_id 的兜底**（修掉旧的"capture 超时即失败"）：response 监听挂在 `goto` 之前；若仍没抓到，用触发前 `report_status` 快照与触发后列表做差集，只认"新增且 `task_status==1`"的行、回填其 task_id 给下游——截没截到都拿得到，不再死等超时。

### 导出在沙箱（仅此一项与生产不同：手动补 chromium）

生产 Docker 镜像自带 chromium，导出开箱即用、可 daemon 定时。调试沙箱本身直连 soar 但**没 bundled chromium**，补一次即可：

```bash
# 1) 项目目录共享：把 Playwright 标准 chromium 拷进 <项目>/.pw-browsers/（已 .gitignore）
#    chromium-1223 / chromium_headless_shell-1223（匹配 playwright 1.60.0，arm64）
# 2) 沙箱设环境变量后导出即可：
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.pw-browsers"
export PLATFORM_COMMAND_USER_ID=local
export PLATFORM_COMMAND_STORAGE_STATE=$PWD/.platform-command/storage-state.json
# 需看界面调试可 headed：export PLATFORM_COMMAND_HEADLESS=false
```
> 不用代理（沙箱直连 soar）、不用 managed Chrome（executablePath 实测不稳）、不用 chrome-mcp——就用 Playwright 标准 chromium，与生产同一套代码。

## 调度 daemon

通用调度守护进程（平台无关，认命令名）：

```
platform-command daemon start [--max-workers 3]   # 常驻：读 store schedule，到点调 export_weekly/monthly
platform-command daemon status
platform-command daemon stop
```

能力：worker 池并发、心跳文件、重启时**漏执行回放**（停机期间应触发的任务）、可插拔 notifier（企业微信 webhook，`PLATFORM_COMMAND_WEBHOOK_URL`）。`mss.set_schedule` 写 store 的 schedule 字段，daemon 扫描时注册。

> 生产 Docker（镜像自带 chromium）下 daemon 可**无人值守定时导出**（export_weekly/monthly 全链，Playwright headless）。调试沙箱需先按「导出在沙箱」补好 chromium + storageState，daemon 同样能跑导出。

## 平台操作铁律（SOP）— agent 必须遵守

迁移自原 skill 的「全局规则 + 禁止事项」，是安全护栏，调用 MSS 命令前后一律遵守。脚本类旧规则（`--output-file`、严禁改脚本）不再适用，已剔除。

**鉴权与失败**
1. 命令报错/返回非 0 code **原样回传，禁止自动重试**；401/403 提示用户刷新登录态，**禁止跳过或忽略鉴权错误**。Cookie/会话有效期约 6 小时。
2. 同一动作**禁止连续重试同一命令**；失败把错误交给用户，等指示。

**参数与身份**
3. **禁止拼接/猜测参数**：所有参数须来自用户明确提供或 store 已有值。
4. **`task_id` 必须由用户提供，禁止推断/补全**；`company_id` 可由命令（search_company）查询。
5. 客户名称由用户提供、模糊匹配由命令处理；**返回多个候选时让用户/agent 选，禁止替用户选或自行猜 `company_id`**。

**动作边界**
6. **禁止在用户未明确要求时自动触发** 导出 / 发邮件 / 同步 portal。
7. **导出必须明确报告类型（weekly/monthly）**，未指定时主动询问，禁止擅自假设。
8. **同一客户禁止并发多命令**，仅串行（批量是跨不同客户并发，单客户内仍串行）。
9. **邮箱增删只能走 `update_email`**，禁止经 `update_config` 改邮箱。
10. 收件人最终 = 平台邮箱 + 本地 added − removed（store delta）。

**沟通**
11. 纯业务交流时**只用业务语言**回应，不暴露内部字段名/技术细节（用户追问内部细节除外）。
12. 定时时间须 `HH:MM` 24h；解析存疑**先与用户确认，不擅自填入**。

> 命令层面已对部分铁律做硬约束（参数必填校验、bodyCode 断言、collect 分页、store derive 的 report_check 门控、daemon 失败通知不静默）；其余（不替选、不自动触发、只用业务语言）由 agent 在编排时遵守。

## Agent 编排说明（有意妥协）

- **自动发邮件的收件人**（= 平台邮箱 + 本地 added − removed，RULE-06）由 agent 在导出后用 `send_email` 完成；`export_weekly/monthly` 自动覆盖"导出 + 同步 portal"。
- **小语种**为前端 i18n（无后端 API）：interceptFlow 的 `page.route` 改写 `export_locales` 注入（`export_locales.js`），零降级，见「导出」。
- **报告改动检测**（newer report）由 agent 用 `report_status` 判断，不在命令内。
- **多客户模糊匹配** 返回候选列表，由 agent/用户选择后用完整客户名重调，命令不替选。
- 名称→companyId、模板选择、小语种拼装等由 agent 串联对应命令完成（基础命令可复用组合）。

## 新增的通用框架能力（非 MSS 专属）

| 模块 | 能力 |
|---|---|
| `src/store.ts` | 平台 store 层（`commands/<platform>/store/`，CRUD+原子写+越界防护） |
| `src/store_command.ts` | `store:{op}` 命令引擎（read/merge/init/delete + 自动初始化） |
| `src/workflow_executor.ts` | 组合执行引擎（command step + 参数管道 + when + forEach + 失败中止 + 末端输出） |
| `data_sources.ts` | 请求体 `bodyBuilder` 钩子；`extract:{fromList,where,pick}`；**`responseType:"binary"` 二进制下载 + `parseDownloadFilename`** |
| `capabilities.ts` | **`download` 输出能力**（存二进制响应到文件，按 content-disposition 文件名；响应非二进制则原样回传） |
| `src/intercept_executor.ts` | 浏览器拦截引擎（`interceptFlow`：route 改写 export_locales + 捕获 task_id + 轮询）；**capture 抓不到时走 `report_status` 快照差集兜底**（监听前置 + 新增且就绪行回填 task_id） |
| `src/daemon.ts` | 通用调度 daemon（并发/心跳/漏执行/通知）+ CLI |
