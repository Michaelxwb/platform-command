# Backend Platform Rules

## Rules
- `execute` 默认 dry-run；真实执行必须显式 `--execute-real --confirm`，任何代码路径不得绕过该安全门 `[README] [docs/safety.md]`
- command JSON schema 变更必须向后兼容：已发布的 command 定义在新版本框架下必须仍可加载执行（never break userspace）
- `playwright` 必须保持 optionalDependency，缺失时框架核心功能（list/describe/verify/execute HTTP 类）不受影响 `[package.json]`
- 命令必须显式声明依赖（requirements），执行前通过 describe/dry-run 暴露 readiness，不得隐式假设 webbridge 可用 `[git log 965c7ba]`
- 发布前 `prepack` 强制 `build && test`，禁止跳过 `[package.json]`
- 外部 commands 通过 `PLATFORM_COMMANDS_DIR` 注入，框架不得假设其存在或可写
- 服务器模式由显式 env 启用（`PLATFORM_COMMAND_USER_ID` / `STORAGE_STATE` / `OUTPUT_DIR` / `DATA_DIR`）；无任何此类 env = 本地模式，行为必须与现版本逐行一致。配置不完整（如设了 STORAGE_STATE 未设 USER_ID）必须显式抛错，禁止静默降级 `[src/server_mode.ts resolveServerMode]`
- 适配器选择只看显式 env，禁止环境自动探测：`browser_session_cookie` + STORAGE_STATE → Playwright，否则 webbridge（本地路径与报错文案逐字不变）`[src/capabilities.ts resolveAdapter]`
- `userId` 只来自容器 env，禁止经命令参数 / 对话层注入；run 记录归属字段由 server_mode 注入（身份不可篡改，NFR-SEC-01）`[src/server_mode.ts] [src/runs.ts]`
- 服务器模式下数据落点（run 记录 + 会话失效标记）由 `PLATFORM_COMMAND_DATA_DIR` 锚定，不得随子进程 cwd 漂移；输出经 `resolveOutputPath` 收敛到 `OUTPUT_DIR`，realpath 防 `..` / 符号链接越界 `[src/server_mode.ts resolveDataBaseDir/resolveOutputPath]`

## Patterns
- 风险分级：command 定义携带 riskLevel，describe/agent manifest 对 Agent 透出，高风险操作要求 confirm
- 验收契约：真实执行后由 `acceptance.ts` 自动核验（file_exists / data_contains），失败要在结果中显式上报 `[git log 0f45b1a]`
- 调度只生成宿主调度器规格（`schedule plan`），不自动安装 `[README]`

## Anti-Patterns
- 禁止把 secret / cookie / token 写进 command JSON 或代码库 `[CLAUDE.md]`
- 禁止破坏已发布 command 的参数语义后不升版本直接发布
- 禁止新增硬依赖来实现可选能力（浏览器、导出等走可选依赖或 webbridge）
