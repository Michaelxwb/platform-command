---
description: 当前任务 mss-report-command-framework 的验收约束（cf-task:start 生成，archive 清理）
---

# 验收约束（精简）

## RULE（平台操作铁律 / SOP）
- RULE-01 导出必须明确 weekly/monthly，未指定由 agent 追问，命令不臆测
- RULE-02 task_id 由用户提供不猜测/补全；company_id 可命令查询
- RULE-03 报错/非 0 code 原样返回，禁止自动重试、禁止连续重试同一命令；401/403 提示刷新登录态，禁止忽略鉴权错误
- RULE-04 同一客户多命令串行；daemon 全局并发上限 = maxWorkers（默认 3）；批量为跨不同客户并发，单客户内仍串行
- RULE-05 邮箱增删只走 update_email，禁止经 update_config 改邮箱
- RULE-06 收件人 = 平台邮箱 + 本地 added − 本地 removed（store delta）
- RULE-07 轮询须有 sleep + 超时上限，禁止忙等
- RULE-08 禁止拼接/猜测参数：参数须来自用户明确提供或 store 已有值
- RULE-09 客户名模糊匹配返回多候选时让用户/agent 选，禁止替选或自猜 company_id
- RULE-10 禁止在用户未明确要求时自动触发 导出/发邮件/同步 portal
- RULE-11 纯业务交流只用业务语言，不暴露内部字段名/技术细节
- RULE-12 定时须 HH:MM 24h；解析存疑先与用户确认，不擅自填入

## 关键场景
- S-03 配置不存在 → display_config 自动初始化默认配置
- S-04 export_report：拦截改写 export_locales → 捕获 generate_report 取 task_id → 轮询至 task_status=1（≤30min）
- S-05 export_weekly：导出→发邮件→同步 portal，上游 task_id 管道下游
- S-07 漏执行：10:00 应跑、11:00 启动，读心跳算出漏执行项并通知
- E-01 401 原样回传不重试；E-02 多匹配返回候选交 agent 选；E-04 子步失败中止回传
- B-02 monthday=31 当月 30 天 → 取当月最后一天
