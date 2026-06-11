# GA 容器配置（FEAT-09：工具约束）

GenericAgent 是第三方开源项目（lsdefine/GenericAgent），不改上游、不维护 fork，
版本由镜像构建参数 `GA_REF` 锁定。

## 工具约束的实现方式（软裁剪三层）

GA 没有配置级的工具开关，容器内采用三层约束代替硬裁剪：

1. **自然失效**：浏览器注入（TMWebDriver 需真实浏览器 userscript 回连）、键鼠/
   屏幕视觉（需显示器）、ADB（需设备）在 headless 容器内本来就没有载体；
2. **SOP 注入**：`platform_command_sop.md` 由 entrypoint 拷入 GA 的 memory/
   （GA 的官方扩展机制），指引平台操作统一经 platform-command CLI、不要尝试
   不可用工具；
3. **容器沙箱兜底**（NFR-SEC-03）：资源限额、只读命令库、输出沙箱、（可选）出网
   白名单——即使模型被诱导滥用工具，破坏面也被限制在该用户自己的容器内。

如未来需要硬裁剪，正确路径是给上游提"按配置禁用工具注册"的 PR，而不是 fork。

## mykey.py 约定

GA 的全部凭证配置（LLM key、IM 渠道凭证、`*_allowed_users` 用户绑定）按官方
约定放在 `mykey.py`。每用户一份（`deploy/users/<userId>/mykey.py`，从镜像内
`mykey_template.py` 提取），由 compose 只读挂载到 `/opt/generic-agent/mykey.py`。
`*_allowed_users` 必须限定为该用户本人的 IM 账号——这是渠道↔userId 身份绑定的
实现点（NFR-SEC-01）。
