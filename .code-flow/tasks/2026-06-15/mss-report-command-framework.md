# Tasks: MSS 报告命令化 + 框架编排/调度增强

- **Source**: .code-flow/tasks/2026-06-15/mss-report-command-framework.design.md
- **Created**: 2026-06-15
- **Updated**: 2026-06-15 — **全部 16/16 done**（build+test 12 组全绿）

## Proposal

将 `mss-report-skill`（SKILL.md + Python 脚本 + 后台 daemon）零降级转换为 platform-command 框架原生命令。为此先给框架补齐三项通用可复用能力——平台 store 层、workflow 编排执行引擎、导出所需的浏览器响应拦截执行——再用 TS 重写通用调度 daemon，最后实现 MSS 原子命令、配置命令与业务组合命令。目标：MSS 全流程进入框架统一模型，原子命令可被复用组合成业务命令，调度具备并发/心跳/漏执行/通知能力。

---

## TASK-001: 平台 store 层（store.ts）

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: mss-report-command-framework.design.md#3.3 数据设计, mss-report-command-framework.design.md#2.3 功能方案 (FEAT-01)

### Description
在框架新增通用 store 读写能力：每个平台命令包下 `commands/<platform>/store/<key>.json` 持久化业务状态。沿用 `resolveCommandResource` 做路径越界防护，相对平台目录（`commandResourceRoot`）解析。提供 `readStore` / `writeStore`（合并补丁）/ 列举接口。平台无关，MSS 仅首个使用者。

### Checklist
- [x] 新增 `src/store.ts`：`readStore(commandDir,key)`、`writeStore(commandDir,key,patch)`、`listStore(commandDir)`（另含 `replaceStore`/`deleteStore`）
- [x] 路径解析复用 `resolveCommandResource`，越界抛错；不存在 key 返回 null
- [x] writeStore 做浅合并 + 原子写（临时文件 rename），保证并发写不损坏
- [x] 单测：读不存在返回 null、写后读回、补丁合并、replace、list、delete、路径越界被拒、非对象 patch 被拒
- [x] `npm run build` + `npm test` 通过

### Log
- [2026-06-15] created (draft)
- [2026-06-15] started (in-progress)
- [2026-06-15] completed (done) — src/store.ts + tests，build/test 绿（另装缺失的 @types/node 修复预存的构建环境）

---

## TASK-002: workflow 执行引擎（workflow_executor.ts）

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: mss-report-command-framework.design.md#3.2 架构设计, mss-report-command-framework.design.md#3.4 接口设计, mss-report-command-framework.design.md#2.3 功能方案 (FEAT-02)

### Description
新增组合命令的真实执行引擎。命令声明 `workflow.steps[]`，step 可引用其它命令（`command` + `params` 模板 + `when` 条件 + `extract`）。引擎按 `dependsOn`/顺序执行，递归调用 `executeCommand`，把上游 `rows/meta` 写入 `context.steps[id]` 供下游模板引用；`when` 假值跳过；任一子步失败中止并回传失败定位。接入 `getExecutionCapability` / `executeCommand`，使 workflow 命令 `executable:true`。

**管道契约**：组合 step 暴露给下游的字段须在该 step 上声明 `extract`（如 `extract:{taskId:'meta.taskId'}`），否则 plan 校验报 UNRESOLVED（与框架既有 recipe 的 runtime 占位机制一致）。

### Checklist
- [x] 新增 `src/workflow_executor.ts`：`executeWorkflow(command, params, opts)`
- [x] 支持 step 形态：`{id, command, params, when, extract, dependsOn}`（非 command 步记录不执行）
- [x] 上游输出（meta + rows + 显式 extract）经 `renderValue` 管道到下游 params；`when` falsy 跳过
- [x] 子步失败/验收失败中止 + 汇总各步结果（成功/失败/跳过）
- [x] 加最大递归深度（MAX_DEPTH=6）与单步超时（默认 30min），防失控（RISK-04）
- [x] `execute.ts` 接入：workflow_compose 走真实执行（动态 import 避免循环依赖）；verify 支持 command step 类型
- [x] 单测：能力识别、参数管道(T123)、when 跳过、子步失败中止
- [x] `npm run build` + `npm test` 通过

### Log
- [2026-06-15] created (draft)
- [2026-06-15] started (in-progress)
- [2026-06-15] completed (done) — workflow_executor + verify/workflow/execute 改造，4 项断言全绿

---

## TASK-003: 导出浏览器拦截执行扩展（playwright_adapter + ui_executor）

- **Status**: done
- **Log-extra**: 新增 `src/intercept_executor.ts`（通用拦截引擎：page.route 改写 + on(response) 捕获 + fetchViaPlaywright 轮询 + urlBuilder 钩子）；execute.ts 接入 engine=ui_intercept（server-mode 门控）；纯逻辑（applyResponseRewrite/pollUntilReady）+ fake-page 编排（改写 export_locales + 捕获 taskId + 轮询就绪）测试绿
- **Priority**: P0
- **Depends**:
- **Source**: mss-report-command-framework.design.md#3.4 接口设计, mss-report-command-framework.design.md#2.3 功能方案 (FEAT-03), mss-report-command-framework.design.md#2.5 验收条件 (S-04,E-03)

### Description
扩展 Playwright UI 执行，支持导出链路：①`page.route` 拦截改写指定接口响应（改 `get_history_pwd` 的 `export_locales`）；②监听捕获指定接口响应（`generate_report` 取 task_id）；③轮询某接口字段至目标值或超时（`report_status` 至 `task_status=1`，≤30min，带 sleep）。新增对应 UI step/action 声明，通用化（拦截/捕获/轮询与具体业务解耦）。

### Checklist
- [ ] `playwright_adapter.ts` 暴露 `page.route` 注册接口（响应改写）能力
- [ ] `ui_executor.ts` 新增动作：`routeFulfill`（URL 模式 + body 字段改写）、`captureResponse`（URL 模式 → 存结果）、`poll`（URL/字段/目标值/间隔/超时）
- [ ] 轮询带 sleep 与超时上限，禁止忙等（RULE-07）；捕获到非 0 code 抛错
- [ ] 单测：route 改写命中改写、capture 取到字段、poll 超时/命中分支（可用本地 mock server 或可注入 page stub）
- [ ] `npm run build` + `npm test` 通过

### Log
- [2026-06-15] created (draft)

---

## TASK-004: 可复用调度 daemon（daemon.ts）

- **Status**: done
- **Log-extra**: src/daemon.ts（通用、平台无关）：iterTriggerTimes/computeMissedJobs（漏执行，含月末 B-02）、selectDueJobs（到点去重）、runWithConcurrency、心跳读写、loadScheduleEntries（store→条目）、stopDaemon/daemonStatus（PID）、可插拔 webhookNotifier；CLI `daemon start/stop/status [--once] [--max-workers]`。
- **持久队列模型（对齐 skill）**：startDaemon 改为「扫描循环只入队 + 每轮写心跳」与「maxWorkers 个常驻 worker 持续消费队列」解耦——长任务（导出≤30min）不阻塞扫描/心跳，空闲 worker 立即领新活；pending 去重防重复入队；扫描体 try/catch 不被瞬时错误打死；空队列 sleep 轮询不忙等。
- 审查修复：daemon once 不留僵尸 PID；send_email cc/bcc 默认空数组不再吞平台配置（回归测试）。单测覆盖核心 7 项。
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: mss-report-command-framework.design.md#2.3 功能方案 (FEAT-04), mss-report-command-framework.design.md#3.3 数据设计, mss-report-command-framework.design.md#2.5 验收条件 (S-06,S-07,E-05,B-01,B-02)

### Description
用 TS 重写通用调度守护进程，平台无关：从 schedule store 读取 `{command,params,cron,timezone}`，worker 池并发消费（`maxWorkers` 默认 3，超出排队），到点调 `executeCommand`。心跳文件记最后活跃时间，重启时按各 schedule cron 回放算出停机期间漏执行项并经 notifier 推送。PID 文件防重复启动。notifier 首期实现企业微信 webhook，接口预留可插拔。

### Checklist
- [ ] 新增 `src/daemon.ts`：`startDaemon(opts)` / `stopDaemon()` / `daemonStatus()`
- [ ] 配置扫描 + schedule 注册（增/改/删，hash 去重）；worker 池并发 + 队列（RULE-04,B-01）
- [ ] 心跳写入 `runs/daemon/heartbeat.txt`；漏执行回放复刻 weekly/monthly/月末边界（B-02）
- [ ] 可插拔 notifier 接口 + 企业微信 webhook 实现；通知失败仅记日志不阻断
- [ ] PID 文件 `runs/daemon/scheduler.pid` 防重复启动
- [ ] CLI 接入：`daemon start/stop/status --max-workers`
- [ ] 单测：并发上限/排队、漏执行回放（含月末 B-02）、重复启动拦截、cron 映射
- [ ] `npm run build` + `npm test` 通过

### Log
- [2026-06-15] created (draft)

---

## TASK-005: MSS JS 逃生口模块（code/date_range.js + code/locale_modify.js）

- **Status**: done
- **Log-extra**: 新增框架 body 变换钩子 `request.bodyBuilder`（data_sources.ts，对称于 query signer）；date_range 单测绿、locale_modify 经 set_locale + hook 测试覆盖；默认 module_list 模板已搬入 commands/mss/templates/
- **Priority**: P0
- **Depends**:
- **Source**: mss-report-command-framework.design.md#2.4 范围与边界 (有意妥协), mss-report-command-framework.design.md#3.1 方案选型

### Description
实现纯模板表达不了的 MSS 业务逻辑，隔离在命令包 `commands/mss/code/`：①`date_range.js` 按 `weekly/monthly` + range_type（Last 7 days/Last week/Last month/Last 30 days）计算 start/end（复刻 `trigger_export.calc_date_range`）；②`locale_modify.js` 为改小语种清洗 logo（去 url 等字段）并在缺失时填默认 module_list（复刻 `api._clean_logo_for_modify` + `_load_default_module_list`）。

### Checklist
- [ ] `commands/mss/code/date_range.js`：导出计算函数，覆盖 4 种 range_type
- [ ] `commands/mss/code/locale_modify.js`：logo 清洗 + 默认 module_list 兜底
- [ ] 迁移默认 module_list 模板到 `commands/mss/templates/`
- [ ] 单测：各 range_type 边界（含上周一~周日、上个自然月、过去30天）、logo 字段裁剪、module_list 兜底
- [ ] `npm test` 通过

### Log
- [2026-06-15] created (draft)

---

## TASK-006: MSS 只读命令三件套（search_company / report_status / get_locale）

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: mss-report-command-framework.design.md#3.4 接口设计, mss-report-command-framework.design.md#2.3 功能方案 (FEAT-05), mss-report-command-framework.design.md#2.5 验收条件 (S-01,S-02,E-01,E-02)

### Description
三个 http_json + return_json 只读命令：`search_company`（report_customer 分页，返回 companyId/companyName）、`report_status`（report_status 分页）、`get_locale`（report config GET，company_id 参数）。鉴权 `browser_session_cookie` + `X-Csrftoken={{session.csrfToken}}`。多匹配/401 原样回传交 agent 处理（不重试、不替选）。

### Checklist
- [x] `commands/mss/cmd/search_company.json`（collect offsetParam 分页）
- [x] `commands/mss/cmd/report_status.json`
- [x] `commands/mss/cmd/get_locale.json`（extract → meta）
- [x] 三者 `runtime.auth.type=browser_session_cookie`、`learnedFrom.url` 设 soar 首页
- [x] 加最小顶层 steps 以通过 verify（auto_capability 仍优先执行）
- [x] dry-run 校验模板渲染与鉴权 readiness（E-01/E-02 由 agent 处理，命令仅回传）
- [x] `npm run build` + verify + dry-run + `npm test` 通过

### Log
- [2026-06-15] created (draft)
- [2026-06-15] started (in-progress)
- [2026-06-15] completed (done) — 3 命令 verify ok、dry-run 渲染正确、全量 test 绿

---

## TASK-007: MSS set_locale 命令

- **Status**: done
- **Log-extra**: GET 抽取 channel_id/module_list/logo → bodyBuilder=locale_modify.js 清洗 logo + module_list 兜底 → MODIFY；verify + dry-run（2 步、bodyBuilder 在位）绿
- **Priority**: P1
- **Depends**: TASK-005
- **Source**: mss-report-command-framework.design.md#3.4 接口设计, mss-report-command-framework.design.md#2.5 验收条件 (B-03)

### Description
改小语种命令：先 GET 当前 config，经 `code/locale_modify.js` 清洗 logo + 兜底 module_list，再 POST config MODIFY（report_type 固定 12）。不支持的语种由平台返回错误，原样回传（B-03）。

### Checklist
- [ ] `commands/mss/cmd/set_locale.json`（多步 http_json，body 经 JS 逃生口构造）
- [ ] 参数 `companyId` + `locale`（id/de/th/空）
- [ ] dry-run 校验；非法语种错误原样回传
- [ ] `npm run build` + dry-run 通过

### Log
- [2026-06-15] created (draft)

---

## TASK-008: MSS query_email_content 命令

- **Status**: done
- **Priority**: P1
- **Depends**:
- **Source**: mss-report-command-framework.design.md#3.4 接口设计, mss-report-command-framework.design.md#2.3 功能方案 (FEAT-05)

### Description
查邮件话术：多步 http_json 拼装 subject（email_theme）+ header（email_header）+ push_content（report_push_content）+ sign（email_sign），return_json 交回 agent 预览。参数 `taskId` + `companyId`（header 需 company_id）。报告改动检测（newer report）不在命令内，由 agent 用 report_status 判断（设计有意妥协）。

### Checklist
- [x] `commands/mss/cmd/query_email_content.json`（4 步 extract → meta）
- [x] 正文各部分 header/pushContent/sign 单独 extract，由 agent 组合
- [x] return_json 输出主题与正文各部分
- [x] `npm run build` + verify + dry-run + `npm test` 通过

### Log
- [2026-06-15] created (draft)
- [2026-06-15] completed (done) — 4 步 actual_data 抽取，dry-run other_param 渲染正确

---

## TASK-009: MSS sync_portal 命令

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: mss-report-command-framework.design.md#3.4 接口设计, mss-report-command-framework.design.md#2.5 验收条件

### Description
同步报告到 portal：POST sync_soc，参数 `taskId` + `reportType`（weekly=2/monthly=3）+ `reportVersion`（小语种数组，默认 ["en"]，agent 可先用 get_locale 拼 [locale,"en"]）。可选轮询 sync_soc 状态确认（带超时）。

### Checklist
- [x] `commands/mss/cmd/sync_portal.json`
- [x] reportType 参数即 portal report_type 整数（2=周报/3=月报，enum 约束）
- [x] dry-run 校验 body 渲染（report_type 数字 + report_version 数组）
- [x] `npm run build` + verify + dry-run + `npm test` 通过

### Log
- [2026-06-15] created (draft)
- [2026-06-15] completed (done) — 单 POST sync_soc，类型化 body 渲染正确

---

## TASK-010: MSS send_email 命令

- **Status**: done
- **Log-extra**: 6 步取值 + send 步（bodyBuilder=send_email_body.js 拼 accepter/ccer/bccer/content/attachments/icon）；收件人为参数（RULE-06 由 agent 解析）；verify + dry-run（7 步）绿
- **Priority**: P0
- **Depends**:
- **Source**: mss-report-command-framework.design.md#3.4 接口设计, mss-report-command-framework.design.md#2.5 验收条件 (RULE-05,RULE-06)

### Description
发送报告邮件：多步 http_json 拼装 payload——subject/header/push/sign/company_name/attachments 由接口查，收件人 recipient/cc/bcc 作为参数传入（agent 用平台邮箱 + store delta 解析，RULE-06）。POST send_email；可选轮询 push_status 确认。参数 `taskId`+`companyId`+`reportType`+`recipient/cc/bcc`。

### Checklist
- [ ] `commands/mss/cmd/send_email.json`（多步拼 payload）
- [ ] attachment_icon/attachments/company_name 组装同 `do_send_email`
- [ ] 无收件人时报错回传；不经此命令改邮箱配置（RULE-05）
- [ ] `npm run build` + dry-run 通过

### Log
- [2026-06-15] created (draft)

---

## TASK-011: MSS export_report 命令（UI 拦截导出）

- **Status**: done
- **Log-extra**: interceptFlow（urlBuilder=export_url.js 算时间范围拼 URL → 改写 export_locales → 捕获 generate_report.task_id → 轮询 report_status）；verify + dry-run（engine=ui_intercept/intercept_plan）绿。真实导出需 server-mode storageState 会话验证（本环境无法 e2e）；拦截机制由 TASK-003 编排测试覆盖
- **Priority**: P0
- **Depends**: TASK-003, TASK-005
- **Source**: mss-report-command-framework.design.md#3.4 接口设计, mss-report-command-framework.design.md#2.5 验收条件 (S-04,E-03), mss-report-command-framework.design.md#2.3 功能方案 (FEAT-03,FEAT-05)

### Description
导出单步命令（不含下游）：解析客户（search_company）→取模板（template_list）→`code/date_range.js` 算时间范围→拼导出页 URL→UI 执行：routeFulfill 改 export_locales（en + 平台小语种）+ captureResponse 取 generate_report 的 task_id + poll report_status 至 task_status=1（≤30min）。参数 `company`+`reportType`。

### Checklist
- [ ] `commands/mss/cmd/export_report.json`（UI steps：goto + routeFulfill + captureResponse + poll）
- [ ] export_locales 组装（en + get_locale 结果，去重）
- [ ] 超时（E-03）原样回传，不静默
- [ ] dry-run 出 UI 计划；真实执行需 storageState 会话
- [ ] `npm run build` + dry-run 通过

### Log
- [2026-06-15] created (draft)

---

## TASK-012: MSS 配置查改命令（display_config / update_config）

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: mss-report-command-framework.design.md#3.4 接口设计, mss-report-command-framework.design.md#2.3 功能方案 (FEAT-06), mss-report-command-framework.design.md#2.5 验收条件 (S-03)

### Description
`display_config`：读 store（不存在则按默认配置自动初始化，S-03），return_json。`update_config`：合并 store 的范围/检查/发邮/同步等开关字段（config 对象只含待改项）。邮箱与定时分别走 TASK-013，不在此命令处理（RULE-05）。company_id 由 agent 先 search_company 解析；小语种/平台邮箱由 agent 另调 get_locale 合并展示。

**新增通用框架能力**：`src/store_command.ts` store 引擎（op=read/merge/init/delete，templated key，缺失按 defaults 自动初始化），接入 getExecutionCapability(engine=store_op)/executeCommand。任何平台命令可复用。

### Checklist
- [x] 新增 `src/store_command.ts` + execute.ts 接入（store_op 引擎）
- [x] `commands/mss/cmd/display_config.json`（store read + 自动初始化 S-03）
- [x] `commands/mss/cmd/update_config.json`（store merge 开关/范围字段）
- [x] 默认配置 defaults 内联于命令（字段见 design §2.3.2）
- [x] 单测：read 自动初始化、merge 只改给定字段、再读不重复初始化 + 两命令 verify/dry-run
- [x] `npm run build` + `npm test` 通过

### Log
- [2026-06-15] created (draft)
- [2026-06-15] started (in-progress)
- [2026-06-15] completed (done) — store 引擎（通用）+ 两配置命令，store command engine 测试绿

---

## TASK-013: MSS 邮箱与定时命令（update_email / set_schedule）

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: mss-report-command-framework.design.md#3.4 接口设计, mss-report-command-framework.design.md#2.5 验收条件 (S-08,RULE-05,RULE-06)

### Description
`update_email`：store merge 邮箱 delta（RULE-05 唯一邮箱入口；数组最终值由 agent 基于现状算好传入）。`set_schedule`：store merge 周/月报 schedule 结构化对象（自然语言→结构由 agent 解析）。与 daemon 经 store 解耦——daemon 扫描时读 weekly/monthly_schedule 字段注册（S-08），故不强依赖 TASK-004 即可落地。

### Checklist
- [x] `commands/mss/cmd/update_email.json`（store merge delta，RULE-05/06）
- [x] `commands/mss/cmd/set_schedule.json`（store merge schedule 结构化对象）
- [x] 时间/格式存疑由 agent 先确认，命令不臆测
- [x] verify + dry-run（mode=store）通过；store 引擎单测已覆盖 merge 语义
- [x] `npm run build` + `npm test` 通过

### Log
- [2026-06-15] created (draft)
- [2026-06-15] started (in-progress)
- [2026-06-15] completed (done) — 两命令复用 store 引擎，verify/dry-run 绿（daemon 注册经 store 解耦）

---

## TASK-014: MSS 业务组合命令（export_weekly / export_monthly）

- **Status**: done
- **Log-extra**: 新增 http_json list-pick extract（fromList/where/pick）+ mss.get_template + export_locales.js；export_weekly/monthly workflow 组合 cfg→tpl→loc→export→send→sync，verify/dry-run 绿。
- **降级闭合（后续补齐）**：自动发邮件已编入组合——store_command 加 derive 钩子（display_config 派生 autoSend/autoSync，复刻 report_check 门控）；send_email 加平台邮箱查询步 + emailsAdded/Removed 参数 + send_email_body 解析收件人（平台+added−removed，复刻 resolve_emails，单测绿）。与 skill `_do_downstream` 行为一致。
- **小语种 portal 同步闭合**：sync_portal 加 bodyBuilder `sync_portal_body.js`，按 locale 拼 report_version（[locale,en]/[en]，复刻 do_sync_portal）；export_weekly/monthly 的 sync 步传 `locale={{steps.loc.locale}}`。单测绿。**至此自动链路与 skill 完全对齐，无残留降级。**
- **Priority**: P0
- **Depends**: TASK-002, TASK-009, TASK-010, TASK-011, TASK-012
- **Source**: mss-report-command-framework.design.md#2.3 功能方案 (FEAT-07), mss-report-command-framework.design.md#2.5 验收条件 (S-05)

### Description
workflow 组合业务命令：export_report → 读 store 开关 → 若 `report_check` 则停在人工检查；否则按 `send_email`/`sync_portal` 开关条件执行 send_email、sync_portal。上游 task_id 经 extract 管道到下游（S-05）。收件人由 store delta + 平台邮箱解析后传入 send_email。

### Checklist
- [ ] `commands/mss/cmd/export_weekly.json` + `export_monthly.json`（workflow.steps 引用原子命令 + when 条件）
- [ ] task_id 从 export 步骤 extract 管道到 send_email/sync_portal
- [ ] report_check=true 时跳过下游并提示人工检查
- [ ] dry-run 出 workflow 计划；步骤失败中止回传（E-04）
- [ ] `npm run build` + dry-run 通过

### Log
- [2026-06-15] created (draft)

---

## TASK-015: MSS 配置汇总命令（export_all_configs）

- **Status**: done
- **Log-extra**: workflow 引擎加 forEach 循环（遍历列表逐项调子命令并收集）+ 末端 output.capability 汇总（export_excel/return_json）；template.ts/workflow.ts 将 forEach 循环变量与 steps.*.rows 作为 plan 期延迟命名空间；export_all_configs（搜客户→forEach 读配置→export_excel）verify/dry-run 绿；forEach 单测（收集 2 客户配置 + store 落盘）绿
- **Priority**: P1
- **Depends**: TASK-002, TASK-001, TASK-012
- **Source**: mss-report-command-framework.design.md#2.3 功能方案 (FEAT-07), mss-report-command-framework.design.md#3.5 质量实现方案

### Description
批量汇总客户配置：全量（fetch_all_companies）或指定多客户，自动初始化缺失配置，汇总为 Excel（export_excel）并经 daemon notifier 推送话术与文件。workflow 组合 search/display_config + export_excel + 通知。

### Checklist
- [ ] `commands/mss/cmd/export_all_configs.json`（workflow：取客户列表 → 逐客户读配置 → export_excel）
- [ ] 列模板 `commands/mss/templates/configs.columns.json`
- [ ] 复用 notifier 推送（与 TASK-004 接口一致）
- [ ] dry-run 通过

### Log
- [2026-06-15] created (draft)

---

## TASK-016: 集成验证（注册/文档/端到端 dry-run + 构建测试）

- **Status**: done
- **Log-extra**: list 列出全部 16 个 mss.* 命令；16/16 verify ok；各引擎 dry-run 正常；`npm run prepack`（build+test）12 组测试全绿；文档 `docs/mss-report-commands.md`（命令集 + 鉴权 + daemon 用法 + agent 编排妥协 + 新增框架能力）。**环境限制**：需 live storageState 会话的导出 e2e（S-04/S-05）本环境无法跑，已由 intercept 引擎 fake-page 编排测试覆盖机制层（改写 export_locales + 捕获 task_id + 轮询就绪）。
- **Priority**: P0
- **Depends**: TASK-001, TASK-002, TASK-003, TASK-004, TASK-005, TASK-006, TASK-007, TASK-008, TASK-009, TASK-010, TASK-011, TASK-012, TASK-013, TASK-014, TASK-015
- **Source**: mss-report-command-framework.design.md#2.5 验收条件, mss-report-command-framework.design.md#4. 部署与运维

### Description
端到端集成：确认所有命令被 `list` 发现、`describe`/`verify`/dry-run 正常；补 README/SKILL 文档说明 MSS 命令集与 daemon 用法；跑发布闸门 `prepack`（build + test）。校验 NL 触发与 return_json 链路。

### Checklist
- [ ] `platform-command list` 列出全部 mss.* 命令
- [ ] 各命令 `verify` / dry-run 无模板未解析错误
- [ ] 文档：MSS 命令集清单 + daemon start/stop/status + 鉴权前置
- [ ] `npm run prepack`（build + test）通过
- [ ] 验收场景 S-01~S-08 / E-01~E-05 / B-01~B-03 逐条核对

### Log
- [2026-06-15] created (draft)

---
