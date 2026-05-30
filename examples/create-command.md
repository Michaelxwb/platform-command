# 创建一个新的 command

1. 在目标页面运行 learn 模式，观察页面结构和网络请求。
2. 查看 `runs/<时间>_<平台>_<动作>/learn_report.json`。
3. 将 `templates/command-template.json` 复制为 `commands/<平台>.<动作>.json`。
4. 填写参数定义、默认值、接口路径、UI 回退路径、成功标准和失败场景。
5. 运行结构校验：

```bash
node src/cli.js verify --command <平台>.<动作>
```

6. 在真实执行前先运行 dry-run：

```bash
node src/cli.js execute --command <平台>.<动作> --dry-run 参数名=参数值
```

7. 确认执行计划、风险等级和参数无误后，再考虑真实执行。
