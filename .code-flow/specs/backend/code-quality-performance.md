# Backend Code Quality & Performance

## Rules
- ESM + NodeNext：相对导入必须带 `.js` 后缀（如 `import { x } from './utils.js'`），否则运行时解析失败 `[tsconfig.json] [src/cli.ts]`
- 测试基于 dist 产物运行：改 `src/` 后必须先 `npm run build` 再 `npm test`，提交前两者都过 `[package.json]`
- tsconfig 当前 `strict: false`；新代码不得依赖隐式 any 放宽来掩盖类型问题，公开函数仍需显式类型签名 `[tsconfig.json] [CLAUDE.md]`
- 异常必须显式处理或显式上抛，禁止 `catch (e) {}` 静默吞掉 `[CLAUDE.md]`
- 外部依赖调用（HTTP / webbridge）必须设置超时，关键调用补重试 + 指数退避
- 单元测试覆盖核心业务路径：happy path + 边界 + 错误分支，每个需求 ≥ 1 个用例
- `runtime.*` 是延迟命名空间：plan/render 阶段保留占位、不报 `UNRESOLVED_TEMPLATE`，`failOnUnresolvedTemplates` 不得因它拒绝命令 `[src/template.ts resolvePath]`

## Patterns
- web-component / shadow-DOM 站点交互：用 JS 递归 shadow 解析（`deepQuery`，支持 `>>>` 链与 `:has-text`）+ Playwright trusted 操作于解析出的 handle（Playwright CSS 不可靠穿透深层 open shadow root）；框架富文本编辑器用键盘输入而非 `fill` 且输入前清空（站点持久化草稿会污染）；写操作结果用 `browser-network-listener:<urlPattern>` 网络回执（code/rpid）确认，不凭点击判成功 `[src/ui_executor.ts]`
- UI 写操作引擎仅服务器模式 + storageState 可执行（engine `playwright_ui`），受 `--confirm` 安全门约束；可选依赖（playwright）必须动态 `import()` `[src/ui_executor.ts] [src/playwright_adapter.ts]`
- 缓存可计算结果以减少重复 IO，明确缓存 key、TTL 与失效策略
- 重 IO 用异步或批处理，CPU 密集任务下沉到 worker / 队列
- 资源（连接、文件、锁）使用 `with` / `using` / `defer` 确保释放
- 性能敏感路径加监控指标（QPS / P95 延迟 / 错误率）

## Anti-Patterns
- 禁止在请求链路中吞掉异常导致客户端拿到错误结果却无日志
- 禁止无超时的外部调用（容易导致线程 / 协程泄漏）
- 禁止用循环模拟批量操作（DB 批量 / 网络批量必须用原生批量 API）
- 禁止把缓存失败当致命错误，缓存层必须可降级为直接查询
