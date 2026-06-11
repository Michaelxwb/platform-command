# Backend Directory Structure

## Rules
- `src/` 采用平铺单层模块，每个文件单一职责（cli / execute / verify / acceptance ...），新增能力优先加独立模块而非塞进现有大文件 `[src/ 现状]`
- 平台 command 必须遵循 `commands/<platform>/{cmd,config,code,templates}` 目录约定：定义放 `cmd/*.json`，默认参数放 `config/*.defaults.json`，辅助 JS 放 `code/`，输出模板放 `templates/` `[commands/]`
- 入口文件（`src/cli.ts`）只做子命令分发，业务逻辑放对应模块
- 公共工具放 `src/utils.ts`，无业务依赖；平台专用逻辑放 `commands/<platform>/code/`
- 新增一级目录或 MCP tool 必须同步更新本导航地图与 README 的 tools 表

## Patterns
- 脚手架统一从 `templates/` 复制（command-template / platform-profile-template / run-log-template）
- 测试统一入口 `tests/run-tests.ts`，编译后以 `node dist/tests/run-tests.js` 运行 `[package.json]`

## Anti-Patterns
- 禁止在根目录堆放脚本与临时代码，临时产物放 `temp/`
- 禁止把平台特定逻辑硬编码进 `src/` 框架层——平台差异通过 command JSON 与 `commands/<platform>/code/` 表达
- 禁止单函数超过 50 行（项目 Core Principles）`[CLAUDE.md]`
