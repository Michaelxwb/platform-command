# Project Guidelines

## Team Identity
- Team: GenericAgent
- Project: platform-command（MCP-first 平台指令框架）
- Language: TypeScript (Node.js >= 18, ESM)

## Core Principles
- All changes must include tests
- Single responsibility per function (<= 50 lines)
- No loose typing or silent exception handling
- Handle errors explicitly

## Forbidden Patterns
- Hard-coded secrets or credentials
- Unparameterized SQL
- Network calls inside tight loops

## Spec Loading
本项目使用 code-flow 两层规范体系。

**两层架构**：
- **Tier 0 `_map.md`（导航地图）**：项目结构、关键文件、数据流。你手动读取，帮助理解代码在哪里。
- **Tier 1 约束规范**：编码规则、模式、反模式。由 Hook 自动注入，你无需手动加载。

**你的职责**：
1. 从问题判断领域：
   - **backend**：src/ 下的 CLI、MCP server、command 执行链路（本项目为纯 TypeScript 后端，无 frontend 域）
2. 读取 `.code-flow/specs/<domain>/_map.md` 获取导航上下文
3. 约束规范由 Hook 在你编辑代码（PreToolUse）或 prompt 引用相关文件（UserPromptSubmit）时自动注入——不要手动读取
4. 问题跨多个领域时，读取所有匹配的 `_map.md`
5. 没有匹配领域时，跳过规范加载

不要询问用户加载哪些规范——系统自动处理约束注入。

## Task Documents (cf-task workflow)

- `.code-flow/specs/shared/` holds PRD/design templates used by `/cf-task:prd` and `/cf-task:align`
- Workflow: `/cf-task:prd` → `.prd.md` → `/cf-task:align <.prd.md>` → `.design.md` → `/cf-task:plan <.design.md>` → tasks
- Templates are read by the commands themselves; you do not need to pre-load them
