# platform-command 默认参数改造计划
需求：实现 command defaults + defaultConfig(global/subjects) + subject fallback，自然语言只补差异参数。
约束：保留既有未提交改动；用 Node；不破坏现有命令和测试。

## 探索发现
- executeCommand 当前直接调用 mergeParams(command, providedParams)，适合在此接入统一 resolver。
- nl.extractParams 当前会把 parameters.default 注入 parsed.params，需要避免默认值遮蔽主体配置。
- command_store.mergeParams 已有类型校验/coerce，可复用，resolver 应先合并配置再调用 mergeParams。

## 执行计划
1. [ ] 新增 src/params_resolver.js：解析 defaults/defaultConfig，按 global -> subject -> provided 合并，并返回 meta。
2. [ ] 接入 executeCommand dry-run/real-run，让输出 params 使用解析后参数并暴露 paramsMeta。
3. [ ] 调整 nl：自然语言只提取显式差异参数，不提前注入 parameters.default。
4. [ ] 给 github.list_issues 增加默认配置示例，覆盖全局与主体 fallback。
5. [ ] 补充 tests/run-tests.js 用例，验证全局默认、主体默认、主体缺省回退、显式覆盖、NL 差异参数。
6. [ ] 运行测试和关键 CLI dry-run 验证。
7. [ ] 查看 git diff，确认未误删既有改动。
