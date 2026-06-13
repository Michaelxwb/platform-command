# Project Guidelines

## Team Identity
- Team: [team name]
- Project: platform-command (`@jahanxu/platform-command`) — MCP 优先的命令框架
- Language: TypeScript (ESM / NodeNext) 为主；Python 用于 GenericAgent 集成与部署镜像

## Core Principles
- All changes must include tests
- Single responsibility per function (<= 50 lines)
- No loose typing or silent exception handling
- Handle errors explicitly
- 唯一部署形态是 Docker 容器（每用户一容器、headless 沙箱）；代码不得假设交互式终端、桌面环境或非容器运行时

## Validation Commands
- 构建：`npm run build`（tsc）｜类型检查：`npm run typecheck`（tsc --noEmit）
- 测试：`npm test`（`node dist/tests/run-tests.js`）
- 发布闸门：`prepack` = build + test，任一失败则 `npm pack` / 发版中止
- 命令冒烟：`npm run verify:demo`、`npm run dry-run:demo`

## Forbidden Patterns
- Hard-coded secrets or credentials
- Unparameterized SQL
- Network calls inside tight loops
- 轮询 / 等待循环无 sleep 或阻塞超时（尤其对 EOF / 空读，会忙等烧满 CPU）
- 平台专属 API（如 `os.startfile`）不加 OS 守卫直接调用

## Spec Loading
本项目使用 code-flow 两层规范体系。

**两层架构**：
- **Tier 0 `_map.md`（导航地图）**：项目结构、关键文件、数据流。你手动读取，帮助理解代码在哪里。
- **Tier 1 约束规范**：编码规则、模式、反模式。编辑代码时（PreToolUse）自动注入完整约束；其他场景注入 **Spec Catalog**（spec 目录），由你按场景自行读取。

**你的职责**：
1. 从问题判断领域：
   - **frontend**：components、pages、hooks、styles、UI、.tsx/.jsx/.css
   - **backend**：services、API、database、models、logging、.py/.go
2. 读取 `.code-flow/specs/<domain>/_map.md` 获取导航上下文
3. 收到 **Spec Catalog** 时，编码前先 Read 其中与当前任务匹配的 spec 全文（路径相对 `.code-flow/specs/`）；prompt 引用明确文件路径或你编辑代码（PreToolUse）时，完整约束自动注入，无需手动读取
4. 问题跨多个领域时，读取所有匹配的 `_map.md`
5. 没有匹配领域时，跳过规范加载

不要询问用户加载哪些规范——按 Catalog 自取或等待自动注入即可。

## 合规反馈协议（quality_loop）

1. 编辑代码后收到 **Spec 合规反馈 (auto-check)** 时，先按提示修正违规，再继续当前任务
2. 用户表示某条反馈是误报（"这是误报"/"忽略这个检查"）时，代为执行：
   `python3 .code-flow/scripts/cf_feedback.py ignore <check-id>`
   （check-id 见反馈中的 `规则: <spec>#<check-id>`；同一规则误报达阈值会自动停用）
3. 会话收尾被校验拦回（cf-stop 反馈未过项）时，修复后再结束；不要绕过
4. 新增/修改规范时优先用 ✅/❌ 代码对照示例表达（见 spec 模板 Examples 段）

## Task Documents (cf-task workflow)

- `.code-flow/specs/shared/` holds PRD/design templates used by `/cf-task:prd` and `/cf-task:align`
- Workflow: `/cf-task:prd` → `.prd.md` → `/cf-task:align <.prd.md>` → `.design.md` → `/cf-task:plan <.design.md>` → tasks
- Templates are read by the commands themselves; you do not need to pre-load them
