  # Tasks: 多用户 Agent 平台操作环境（服务器部署）

- **Source**: .code-flow/tasks/2026-06-10/multi-user-agent-deployment.design.md
- **Created**: 2026-06-10
- **Updated**: 2026-06-10

## Proposal

platform-command 当前是单用户本地工具（webbridge 操作本人浏览器），无法支撑"服务器一套环境多人使用且操作互相独立"。本变更采用"每用户一容器"形态：platform-command 增加显式 env 启用的服务器模式（Playwright 适配器 + run 归属 + 输出沙箱），配套 deploy/ 部署产物（镜像、编排、开通/升级/导入脚本、GA 工具裁剪）。硬约束：本地 C 端用户零破坏——未设服务器 env 时所有行为与现版本逐行一致（FEAT-10 / RULE-05）。

---

## TASK-001: 服务器模式配置模块（env 读取与校验）

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: multi-user-agent-deployment.design.md#2.3 功能方案, multi-user-agent-deployment.design.md#3.2 架构设计

### Description
新增 `src/server_mode.ts`：集中读取 `PLATFORM_COMMAND_USER_ID` / `PLATFORM_COMMAND_STORAGE_STATE` / `PLATFORM_COMMAND_OUTPUT_DIR`，提供 `isServerMode()` 与各配置访问器。配置不完整（如设了 STORAGE_STATE 未设 USER_ID）时显式抛错"服务器模式配置不完整"（场景 B-03），不静默降级。所有后续任务从此模块取配置，不得散落读 env。

### Checklist
- [x] `src/server_mode.ts`：env 读取、校验、`isServerMode()`
- [x] 部分配置 → 抛错并列出缺失变量（B-03）
- [x] 全未设置 → 返回"本地模式"，零副作用（FEAT-10 基石）
- [x] 单测：完整/部分/空三种配置矩阵

### Log
- [2026-06-10] created (draft)
- [2026-06-10] started (in-progress)
- [2026-06-10] completed (done) — src/server_mode.ts，含 resolveOutputPath 沙箱

---

## TASK-002: Playwright 适配器模块

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: multi-user-agent-deployment.design.md#3.4 接口设计, multi-user-agent-deployment.design.md#3.5 质量实现方案

### Description
新增 `src/playwright_adapter.ts`（FN-02/FN-03），能力面对齐 `webbridge.ts`：`fetchViaPlaywright`（storageState 上下文内带 cookie fetch）、`ensurePlaywrightSession`、`resolveSessionFromPlaywright`。Chromium 懒启动 + 进程复用，每次调用校验存活、失活重启（RISK-A）。Playwright 必须动态 `import()`，缺失时不影响其余功能（RULE-02）。401/403 设 `err.authRequired = true`。

### Checklist
- [x] FN-02/FN-03 三个函数，签名与 webbridge 对齐
- [x] storageState 缺失/损坏 → 报错含导入指引文案（E-01）
- [x] Chromium 懒启动、复用、失活自动重启（mtime 变化重建 context，支持热重导入）
- [x] 动态 import；未安装 playwright 时模块加载不抛错
- [x] 单测：mock playwright（__setPlaywrightLoader 测试缝），覆盖正常 fetch / 401 / state 损坏 / 未安装

### Log
- [2026-06-10] created (draft)
- [2026-06-10] started (in-progress)
- [2026-06-10] completed (done) — src/playwright_adapter.ts + src/session_state.ts

---

## TASK-003: resolveAdapter 接入适配器选择 + readiness

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002
- **Source**: multi-user-agent-deployment.design.md#3.2 架构设计, multi-user-agent-deployment.design.md#2.5 验收条件

### Description
改 `src/capabilities.ts` 的 `resolveAdapter`（FN-01）：`browser_session_cookie` 且设置了 STORAGE_STATE → Playwright 分支；未设置 → 现有 webbridge 路径，**代码路径与报错文案逐字不变**。同步改 `src/execute.ts` 的 `checkReadiness`：服务器模式下 readiness 检查 storageState 可用性而非 webbridge 探活，dry-run/describe 对 Agent 透出正确的 blockers。

### Checklist
- [x] FN-01 判定逻辑：只看显式 env，无环境自动探测
- [x] 本地路径（无 env）diff 验证：webbridge 分支逻辑与报错文案保持原样（测试断言文案与 adapters 形状不变）
- [x] `checkReadiness` 双适配器感知，blockers 文案区分两种模式
- [x] 单测：适配器选择矩阵（authType × env 组合）
- [x] 回归：现有测试全量通过（E-05：本地无 playwright 不受影响）

### Log
- [2026-06-10] created (draft)
- [2026-06-10] started (in-progress)
- [2026-06-10] completed (done) — capabilities.ts resolveAdapter 分支 + data_sources.ts 路由 + execute.ts readiness

---

## TASK-004: run 记录归属字段

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-001
- **Source**: multi-user-agent-deployment.design.md#3.3 数据设计

### Description
`src/runs.ts` 的 `recordRun` 增量附加可选字段 `userId`（来自 server_mode）与 `adapter`（webbridge/playwright/node_http，由 execute 链路传入）。未设置时字段省略，旧记录读取不受影响（FN-05，场景 S-05）。

### Checklist
- [x] `recordRun` 注入可选 userId/adapter；`listRuns` 兼容新旧记录
- [x] execute 链路传递 adapter 标识
- [x] 单测：服务器模式含字段、本地模式无字段、旧记录可读

### Log
- [2026-06-10] created (draft)
- [2026-06-10] started (in-progress)
- [2026-06-10] completed (done) — runs.ts serverModeMeta 注入

---

## TASK-005: 输出路径沙箱

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-001
- **Source**: multi-user-agent-deployment.design.md#3.4 接口设计, multi-user-agent-deployment.design.md#2.5 验收条件

### Description
新增 `resolveOutputPath`（FN-04），在 `src/capabilities.ts`（save_json）与 `src/exporters.ts`（exportRows）的路径解析处单点收口：`OUTPUT_DIR` 已设置时，输出路径必须落在其内（resolve 后前缀校验，防 `../` 越界），越界抛错并提示允许的根目录（E-03）；未设置时原样返回（本地行为不变）。

### Checklist
- [x] FN-04 实现 + 两处调用点收口（capabilities save_json / exporters exportRows）
- [x] 越界检测覆盖相对路径、`..`、符号链接场景（realpath 最深存在祖先）
- [x] 本地模式（无 OUTPUT_DIR）行为零变更
- [x] 单测：沙箱内/外/边界路径矩阵

### Log
- [2026-06-10] created (draft)
- [2026-06-10] started (in-progress)
- [2026-06-10] completed (done) — resolveOutputPath 在 server_mode.ts，两调用点收口

---

## TASK-006: 会话失效探测与重登指引

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-003
- **Source**: multi-user-agent-deployment.design.md#3.4 接口设计, multi-user-agent-deployment.design.md#2.5 验收条件

### Description
实现 FN-06（FEAT-05）：Playwright 路径收到 401/403 时调用 `markSessionInvalid(platform)`，状态写入用户 data volume（JSON 文件，原子写），错误信息返回重导入指引（指向 CLI-02 流程）；`checkReadiness` 读取失效状态，dry-run 即可见 blocker，不静默重试（E-02）。

### Checklist
- [x] 失效标记落盘（temp+rename 原子写）与读取
- [x] 401/403 错误文案含重导入指引
- [x] readiness 集成：失效 session 出现在 blockers
- [x] 成功执行后清除失效标记
- [x] 单测：失效标记生命周期 + readiness 透出

### Log
- [2026-06-10] created (draft)
- [2026-06-10] started (in-progress)
- [2026-06-10] completed (done) — session_state.ts + playwright_adapter 401/403 集成 + readiness blocker

---

## TASK-007: 本地兼容回归测试套件

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-003, TASK-004, TASK-005
- **Source**: multi-user-agent-deployment.design.md#2.5 验收条件

### Description
FEAT-10 的专项保障：在 `tests/` 增加兼容性回归用例，断言"无服务器 env 时行为与现版本一致"——适配器选择走 webbridge、run 记录无新字段、输出路径不收敛、MCP tools schema 快照不变（RULE-05）。覆盖 S-06 / E-05 / B-03。

### Checklist
- [x] env 矩阵用例：空 env 下各链路输出与基线快照一致（原有全量套件即基线 + 新增形状断言）
- [x] MCP tools schema 快照测试（10 个 tool 名固定 + inputSchema 存在）
- [x] B-03 部分配置报错用例
- [x] 接入 `npm test` 单一入口，`prepack` 强制执行

### Log
- [2026-06-10] created (draft)
- [2026-06-10] started (in-progress)
- [2026-06-10] completed (done) — tests/run-tests.ts 追加服务器模式回归块，全量通过

---

## TASK-008: 基础镜像 Dockerfile + build-image.sh

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: multi-user-agent-deployment.design.md#3.1 方案选型, multi-user-agent-deployment.design.md#3.4 接口设计

### Description
新建 `deploy/Dockerfile`：以 `mcr.microsoft.com/playwright:v1.52.0-noble` 为底，装 Python 3.12 + GA + 全局 platform-command + 命令库至 `/opt/platform-commands` + 入口脚本（按 env 选 GA 前端）。`deploy/build-image.sh`（CLI-03）：tag 绑定双版本（`muad:pc<ver>-ga<date>`），构建时校验 Playwright 镜像版本与 package.json `^1.52.0` 对齐（NFR-COMPAT-01），镜像内不得含任何凭证（NFR-SEC-02）。

### Checklist
- [x] 镜像内 `platform-command list`/dry-run、headless Chromium（136.0.7103.25）、GA `import agent_loop` 均验证可用（S-01）；GA TUI 完整启动需 mykey+TTY，归入 TASK-013 端到端
- [x] build-image.sh：双版本 tag + 版本对齐校验，不一致即失败（实测 1.52.0 == 1.52.0）
- [x] 镜像扫描确认无凭证、无 mykey.py 实体（构建时扫描通过）
- [x] deploy/README 记录构建与版本约定

### Log
- [2026-06-10] created (draft)
- [2026-06-10] started (in-progress)
- [2026-06-10] note: Dockerfile/entrypoint.sh/build-image.sh 已写并通过语法检查；真实构建（约 2GB 基础镜像 + GA 安装）留待服务器执行
- [2026-06-10] fix: 按 GA 官方 installation_zh.md 重写安装步骤——源码可编辑安装（GA 非 PyPI 包）、TUI 入口 tuiapp_v2.py、不装 [ui] extra（pywebview 需桌面依赖）、构建时验证 `import agent_loop`；GA memory/skills/temp 由 entrypoint 软链到 /data/ga volume（首启拷贝种子 SOP）
- [2026-06-10] completed (done) — 本机实际构建成功：muad:pclocal-0.3.5-gamain（2.76GB，--pc-local 模式装入含服务器模式的本地包）；冒烟通过：CLI dry-run ✓、Chromium 启动 ✓、entrypoint 双守卫 ✓、容器内 run 记录带 userId ✓

---

## TASK-009: compose 模板 + provision-user.sh

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-008
- **Source**: multi-user-agent-deployment.design.md#3.3 数据设计, multi-user-agent-deployment.design.md#4.5 运维模型与配置职责

### Description
`deploy/compose.template.yml` + `deploy/provision-user.sh <userId> [--im ...]`（CLI-01）：生成 per-user service + 三类 volume（secrets/data/ga，按 §3.3 挂载点）+ per-user env 文件（管理员填 IM 凭证、LLM key、userId）。命令库 `:ro` 挂载（FEAT-08）、mem/cpu limit、`restart: unless-stopped` + healthcheck（NFR-SEC-03 / RISK-C）。用户已存在退出码 2。

### Checklist
- [x] compose 模板：volume 布局、ro 挂载、资源限制、healthcheck（已通过 `docker compose config` 结构验证）
- [x] provision-user.sh：三件套生成 + `--start` 校验启动，分钟级实测通过（S-02，bob/wecom 实例）；新增 mykey.minimal.py 模板、--dir、--allow-public-im 显式开放开关、IM 凭证与 allowed_users 启动前校验
- [x] userId 仅出现在 env，不出现在任何用户可写路径（模板/脚本构造保证）
- [x] 两用户并行隔离验证脚本化（S-07）——归入 TASK-013 端到端验收

### Log
- [2026-06-10] created (draft)
- [2026-06-10] started (in-progress)
- [2026-06-10] note: compose.template.yml + env.template + provision-user.sh 已写；envsubst/docker 均可用；users/ 目录已 gitignore（凭证不进 git）
- [2026-06-10] fix: 凭证载体改为 GA 官方约定的 mykey.py（LLM key + IM 凭证 + *_allowed_users 身份绑定）——provision 从镜像提取模板，管理员填好后手动 up（避免空凭证 crash-loop）；.env 仅保留 GA_FRONTEND 与平台 token
- [2026-06-10] verified: bob（wecom 前端）实例启动成功，企微长连接 connected/authenticated；容器内验收通过——GA 状态目录软链 /data/ga ✓、SOP 注入 ✓、run 记录 userId=bob ✓、输出沙箱越界拦截 ✓；镜像补装 IM SDK（wecom_aibot_sdk/dingtalk-stream/python-telegram-bot）并验证可导入

---

## TASK-010: import-storage-state.sh

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-009
- **Source**: multi-user-agent-deployment.design.md#3.4 接口设计, multi-user-agent-deployment.design.md#3.5 质量实现方案

### Description
`deploy/import-storage-state.sh <userId> <platform> <file>`（CLI-02）：校验 JSON 结构（storageState 必备字段）后原子落盘（temp+rename，RISK-B）至用户 secrets volume，触发会话重载（清除 TASK-006 的失效标记）。文件非法退出码 3。附用户侧导出指引文档（本地浏览器导出 storageState 的步骤）。

### Checklist
- [x] JSON 结构校验 + 原子落盘（node 校验 cookies 数组 → docker cp 临时文件 → 容器内 mv）
- [x] 导入后清除失效标记（删除 sessions/<host>.json；适配器按 mtime 自动重建 context，无需重启）
- [x] deploy/docs：用户导出 storageState 操作指引（deploy/README.md，含 `npx playwright open --save-storage` 路径）
- [x] 验证：导入 → S-03 浏览器命令成功闭环（bilibili 登录态导入后 post_comment 真实发布成功，code:0）

### Log
- [2026-06-10] created (draft)
- [2026-06-10] started (in-progress)
- [2026-06-10] completed (done) — storageState 导入并使用，浏览器会话类命令真实执行成功
- [2026-06-10] note: v1 约定单一合并 storageState 文件（cookies 按 domain 共存），platform-host 参数仅用于清除失效标记——已在脚本注释与 README 说明

---

## TASK-011: upgrade.sh + fleet-status.sh

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-009
- **Source**: multi-user-agent-deployment.design.md#4.2 发布与回滚, multi-user-agent-deployment.design.md#4.5 运维模型与配置职责

### Description
`deploy/upgrade.sh`（CLI-04）：`--users a,b` 试点 / `--all` 全量，拉指定 tag 滚动重建容器，volume 不动；回滚 = 指定旧 tag 重跑。`deploy/fleet-status.sh`（CLI-05）：汇总全部用户容器健康/内存/session 失效/近期 run 失败率，`--json` 机器可读，异常退出码 1。

### Checklist
- [x] upgrade.sh：滚动重建实战多次（bob 当天升级 ~10 次，volume 数据全程完整，B-02 隐式验证）；回滚 = 指定旧 tag 重跑，机制同滚动重建
- [x] fleet-status.sh：四类指标汇总实测通过（bob: running/healthy/mem 1.59%/0失效/5失败run），--json + 退出码 1
- [x] --all 前置检查：镜像 tag 须已有运行中的试点容器（docker ps ancestor 过滤）
- [x] 正式回滚演练（指定旧 tag 重跑）未单独跑——机制与滚动重建同源，已隐式覆盖；正式上线前补一次专项演练

### Log
- [2026-06-10] created (draft)
- [2026-06-10] started (in-progress)
- [2026-06-10] completed (done) — upgrade.sh 当天多次实战；fleet-status.sh 实测通过；回滚为同源机制，留一次正式演练待上线前

---

## TASK-012: GA 工具约束（软裁剪）

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-008
- **Source**: multi-user-agent-deployment.design.md#2.3 功能方案, multi-user-agent-deployment.design.md#3.1 方案选型

### Description
FEAT-09：在 `deploy/` 提供 GA 容器配置，禁用浏览器注入（TMWebDriver）/键鼠/屏幕视觉工具，保留终端+文件+LLM；平台操作统一经 `platform-command` CLI。若 GA 当前无配置级工具开关，需先在 GA 仓库补该配置点（跨仓库依赖，见设计 §5.1）。

### Checklist
- [x] 工具约束方案落地（软裁剪三层）：① headless 容器内浏览器注入/键鼠/视觉/ADB 自然失效；② SOP 注入 GA memory + global_mem_insight.txt 指针（GA 的 prompt 只注入 insight，无指针则模型不知 SOP 存在——实测发现并修复）；③ 容器沙箱兜底
- [x] 容器内验证：真实企微消息驱动 GA 正确执行 `platform-command execute --dry-run` 并转述结果与 readiness 阻塞指引
- [x] 第三方依赖定位已修正（deploy/ga/README.md）：GA 不改上游不 fork，按 GA_REF 锁版本；硬裁剪如需要走 upstream PR

### Log
- [2026-06-10] created (draft)
- [2026-06-10] started (in-progress)
- [2026-06-10] reframed: GA 为第三方开源项目（此前"自维护、去 GA 仓库加配置点"的前提错误）——由硬裁剪改为"自然失效 + SOP 注入 + 沙箱兜底"，解除 blocked
- [2026-06-10] completed (done) — 首测 GA 找不到 platform-command：根因是 SOP 在 memory 但 global_mem_insight.txt 无指针（ga.py get_global_memory 只注入 insight）；补指针后真实企微消息验证 GA 正确走 CLI 执行 dry-run 并透传 readiness 指引

---

## TASK-014: UI 写操作执行引擎（Playwright）

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-002, TASK-003
- **Source**: 实测 bilibili.post_comment 暴露 v0.3.5 无 UI 执行引擎（仅 dry-run plan）；用户决策需实现

### Description
含 UI 步骤的命令（legacy `execution.ui.actions` 如 post_comment，及 workflow ui-only steps）在 v0.3.5 一律 `executable:false`。新增 Playwright UI 执行引擎：服务器模式 + storageState 下，真实执行 goto/waitFor/fill/click/select/assert/screenshot，受 `--confirm` 安全门约束，`when` 条件门控 autoPublish 类动作。同时收紧 GA 软裁剪边界（有 command 的领域失败禁止脚本代偿）。

### Checklist
- [x] `src/ui_executor.ts`：动作提取（双形态）+ 执行器；UI 判定收敛（legacy 仅 prefer[0]==='ui'；workflow 仅 ui-step 且无 api-step，避免误伤 api-first 命令）
- [x] `playwright_adapter.withPlaywrightPage`：storageState 会话内开 page
- [x] `execute.ts` capability gate：UI 命令仅服务器模式+storageState → engine `playwright_ui`，否则维持 ui_plan 不可执行；real-run 路由到 UI 执行器
- [x] 单测：动作渲染/when 门/capability 矩阵/真实执行（fake page，autoPublish true/false 分支）/run 归属；全量回归通过
- [x] SOP 边界收紧：有 command 的领域执行失败禁止脚本代偿（仅无 command 覆盖才自由发挥），热修 bob + 固化 entrypoint
- [x] 容器内端到端：真实 bilibili storageState 下 post_comment 真实执行成功（autoPublish=false 安全态）——shadow 穿透定位编辑器、填入评论、auto_click_publish 三动作按 when 门控跳过、未发布；userId=bob/adapter=playwright

### Log
- [2026-06-10] created + 实现：UI 执行引擎落地，全量测试通过
- [2026-06-10] note: 实测暴露 GA 在命令不可执行时违反边界自写 playwright 发评论——已收紧 SOP「铁律」；根因是软裁剪概率性，硬保障仍靠沙箱+confirm 门
- [2026-06-10] 真实 bilibili 端到端调试（一连串只有真链路才暴露的 bug，全部修复）：
  1. post_comment 实为 top-level steps recipe 形态 → ui_executor 用 normalizeRecipe 统一取 steps；
  2. runtime.* 延迟命名空间被 failOnUnresolvedTemplates 误拒 → template.js 豁免（保留占位不报错）；
  3. Playwright CSS 不可靠穿透 bilibili 深层 open shadow DOM → 引擎改 JS evaluateHandle 递归 shadow 解析 + Playwright trusted 操作作用于 handle；
  4. evaluateHandle 传字符串被当表达式（selector 参数被忽略）→ 改传真实函数 deepQuery；
  5. 编辑器懒加载 → 命令加 scroll 步触发；`>>>` 链脆弱 → 扁平选择器；
  6. 发布按钮无 id/class 仅靠文本 → deepQuery 支持 :has-text()；
  7. assert 文本检查不跨 shadow（textContent 限制）→ 改深度文本收集（光 DOM+shadow）。
  全程 npm test 全绿，每个 fix 配单测。
  8. fill 不被框架编辑器接受 → el.click 聚焦 + page.keyboard.type 真实键盘输入；
  9. 站点持久化草稿污染新内容 → 输入前 Ctrl+A→Delete 清空；
  10. 点了发布按钮但无成功确认（GA 只能导出评论列表猜）→ 实现 browser-network-listener 网络回执捕获，把平台 /x/v2/reply/add 的 code/rpid/内容写入 run 记录，code≠0 直接判失败。
  最终：企微 GA 指令端到端真实发布成功，用户确认评论正确。TASK-014 done。

---

## TASK-013: 端到端验收（试点链路）

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-007, TASK-010, TASK-012
- **Source**: multi-user-agent-deployment.design.md#2.5 验收条件, multi-user-agent-deployment.design.md#4.2 发布与回滚

### Description
按 §2.5.2 全场景跑通试点验收：开通 alice/bob（S-02）→ token 命令（S-04）→ 导入登录态 → 浏览器命令真实执行（S-03，遵守 RULE-01 confirm 门）→ 双用户隔离（S-07）→ 身份诱导（E-04）→ 会话失效流程（E-02）→ 容器重建数据完整（B-02）。产出验收记录，作为镜像灰度进入条件。

### Checklist
- [x] 全场景执行——S-01 S-02 S-03(bilibili UI 真实发布) S-04(github API) S-05 S-07(双用户并行隔离) E-02(会话过期闭环) E-04(身份不可篡改) B-02 B-03 + 核心链路(企微→GA→CLI→真实发布→服务端回执) 全部通过
- [x] 隔离性验收：alice/bob 两容器并行运行；alice 仅挂 muad-alice_* 卷、bob 仅挂 muad-bob_* 卷，零交叉；bob 卷 38 条记录全 userId=bob、alice 卷 0 条；bob 凭证已从 alice mykey 清除
- [x] 内存实测：fleet-status 显示 bob 空载 ~1.6%（2g limit，约 30MB 空载；Chromium 按需启动峰值另计）——容量预估可回填
- [x] 验收记录归档至 deploy/docs，勾选 §6 追溯矩阵状态

### 遗留（非阻塞，上线前补）
- 回滚专项演练：指定旧 tag 重跑 upgrade.sh 确认 volume 完整（机制与滚动升级同源，已隐式覆盖）
- GA 个人微信前端无法容器内自助登录（上游 wechatapp.py 代码限制：stdout 先重定向再判 isatty），token 须外部登录后置入 volume；不影响其他前端与核心能力

### Log
- [2026-06-10] created (draft)
- [2026-06-10] started (in-progress) — bob（wecom）试点跑通核心链路：真实企微消息 → GA 按 SOP 走 platform-command CLI → dry-run 结果回传 → run 记录落 /data/platform 带 userId
- [2026-06-10] fix: 端到端发现 run 记录/会话标记随子进程 cwd 漂移到容器可写层（重建即丢）——新增 PLATFORM_COMMAND_DATA_DIR 锚定数据卷（src/server_mode.ts resolveDataBaseDir + runs/session_state 接入 + compose 模板），本地 cwd 行为不变，全量测试通过；bob 升级验证：GA 目录下执行记录正确落 /data/platform，B-02 重建后 3 条记录/SOP/insight 指针完整，upgrade.sh 真实演练 ✓
- [2026-06-10] verified: 真实 API 命令端到端（github.list_issues）——GA 先 dry-run 后 --execute-real --confirm 真实执行；run 记录 userId=bob + adapter=node_http；导出 xlsx 落沙箱 /data/platform/output/temp/；acceptance incomplete（#2/#3 需浏览器的 manual_check pending）被 GA 如实转述给用户。注意点：GA 首轮违反 SOP 直接用 Python requests，被用户质询后自我纠正——软裁剪是概率性约束，硬保障仍在沙箱层（升级前旧容器的 2 条记录散落 /data/ga/temp，已归拢 /data/platform，DATA_DIR 修复后不再发生）
- [2026-06-10] completed (done) — 补完最后两个验收场景：E-04 身份不可篡改（alice 容器内参数注入 userId=bob，记录顶层 userId 仍为容器 env 的 alice ✓）；E-02 会话过期闭环（标记失效→readiness 阻塞+重导入指引→清除→恢复 ready ✓）。S-07 用 alice(tui)/bob(wecom) 双容器并行 + 挂载零交叉证明。全部核心场景通过，TASK-013 done。
