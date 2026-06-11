# Backend Logging

## Rules
- 敏感信息记录前必须脱敏：headers 走 `maskHeaders`，任意值走 `redactSensitive`，禁止明文输出 cookie / token / 密码 `[src/utils.ts]`
- command 执行日志统一写入 `runs/` 目录，格式参考 `templates/run-log-template.md`，由 `src/runs.ts` 统一列举与汇总 `[src/runs.ts]`
- 关键路径（执行入口、外部调用、浏览器动作、异常分支）必须输出可追溯日志
- MCP stdio 模式下禁止向 stdout 打印非协议内容（会破坏 MCP 帧），诊断信息走 stderr 或 runs 日志

## Patterns
- 统一字段命名：`request_id`、`user_id`、`route`、`status`、`latency_ms`、`error`
- 异常日志必须带堆栈（`exc_info=True` 或等价机制）
- 高频路径用采样日志，避免 IO 阻塞主流程
- 诊断日志走 stderr；结构化执行记录走 `runs/`（框架统一写入，业务 command 不自行写文件）

## Anti-Patterns
- 禁止在循环或热路径中无脱敏地打印请求体
- 禁止用 `print` / `console.log` 替代日志框架
- 禁止吞掉异常仅打 `logger.error("failed")`，必须保留原始错误与上下文
