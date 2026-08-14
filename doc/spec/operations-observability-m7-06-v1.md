# M7-06 运维可观测性 Spec v1

## 1. 关联计划

- 工作包：`M7-06 监控告警`、`M7-07 限流与预算`、`M7-11 运维文档`。
- 复用：Web liveness、pg-boss 队列健康、组织存储额度、Provider 健康记录、ProcessingJob 与 ModelCall 审计。

## 2. 目标

- 建立不含正文、题目、用户问题、来源 URI、密钥、主机路径或模型输入的系统运行快照。
- 将 Web 存活、数据库就绪、Worker 最近心跳、队列积压/死信、处理失败、Provider 健康、模型调用失败率与组织存储容量在管理员设置页和机器接口中统一呈现。

## 3. 规则

- `/api/health` 继续只作为无状态 liveness；新增 readiness 仅返回 `ready`/`degraded` 及稳定原因码，不返回连接串、SQL、堆栈、队列 payload 或业务对象。
- Worker 仅写一个进程/部署级心跳，不写任务正文；超过可配置阈值未刷新为 `stale`。Web 不得把没有 Worker 心跳误报为可处理任务。
- 心跳表在尚未完成数据库迁移的环境中不可读时，组织快照必须把 Worker 单独显示为 `unavailable`，继续返回其他可用指标；不得暴露数据库错误或把这一降级伪装成健康。
- 管理员快照按组织权限过滤，返回计数、时间、百分比和脱敏 ID 摘要；不可用子系统用局部 `unavailable` 显示，不因单项失效掩盖其他状态。
- 默认告警阈值：Worker 120 秒无心跳、死信大于 0、processing 超过 15 分钟、Provider 全部不可用、模型失败率大于 20%、存储大于 85%。阈值先作为快照告警，不自动发送外部通知。
- 快照、健康检查和告警判断只读；死信重驱、Provider 连通测试、备份和迁移仍采用现有显式操作与审计。

## 4. 影响面

- `packages/database`：Worker 心跳持久化与 SQL migration。
- `packages/core`：只读快照、阈值判断与稳定告警码。
- `apps/worker`：启动、周期刷新和退出时停止写心跳。
- `apps/web`：liveness/readiness Route、管理员快照 Route 与设置页展示。
- `deploy`：healthcheck/readiness、运行手册和后续 Prometheus/外部告警适配边界。

## 5. 验收

- 数据库不可用时 readiness 返回 503 稳定码；数据库可用时返回 ready，不访问业务正文。
- Worker 正常、失联、过期的心跳状态可复现；重复启动不产生无限记录。
- 管理员可读取组织快照，非管理员为 403；快照不泄露其他组织的 Provider、任务、存储或模型统计。
- 每个默认阈值有正常/超阈值测试；快照 API、Web UI 和日志不包含敏感正文或密钥。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e` 与 Compose 校验通过。

## 6. 非范围

- Prometheus/OpenTelemetry 服务器、短信/邮件/IM 告警、自动扩缩容、跨节点 leader 选举、SLO 报表、任意任务 payload/原文采集和自动重驱。
