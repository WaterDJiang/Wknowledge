# 死信队列运维 M2-06 Spec v1

## 1. 关联计划

- 工作包：`M2-06 任务韧性`，补齐 pg-boss 已配置但不可观测、不可受控重驱的死信运维缺口。

## 2. 目标

- 组织管理员能在系统设置查看 `resource.process` 与其死信队列的汇总状态。
- 管理员能按明确批次把该来源队列的死信任务重新投递到原处理队列。
- 业务资料的 `failed` 状态与 pg-boss 死信记录分别显示，不把“重新处理”伪装成死信重驱。

## 3. 范围与边界

### 包含

- `GET /api/settings/queue-health`：返回资源处理队列和死信队列的状态计数、最早死信时间和最多 20 条脱敏元数据。
- `POST /api/settings/queue-health/redrive`：仅组织 admin/owner；只重驱来源为 `resource.process` 的死信任务，单次 1–100 条，默认 25 条。
- 读取和重驱均通过 pg-boss 官方 `getQueueStats`、`findJobs`、`redrive` 接口；响应不得返回任务 payload、原文件路径、错误堆栈或 pg-boss 数据库内部连接信息。
- 重驱写组织审计事件，记录 batch 数和实际移动数，不记录任务 payload。
- 设置页展示队列健康摘要、最近死信时间、有限批次重驱操作、空态和可操作错误。

### 不包含

- 批量删除死信、跨队列 destination 覆盖、编辑原任务 payload、单个任务强制完成。
- outbox、失败原因聚类、告警通知、重驱调度、任意用户空间级死信隔离。
- 变更不可变 ResourceVersion、raw、compiled、Wiki 或已失败 ProcessingJob 的历史证据。

## 4. 安全与一致性

- 只有组织 owner/admin 可见或重驱；未登录 401，其他组织角色 403。
- 每次重驱只允许固定来源 `resource.process`，并限制 1–100；同源多个死信按 pg-boss 最早优先规则处理。
- `redrive` 只移动 pg-boss 死信任务并重建其队列消息；ProcessingJob 的人工重试仍通过既有 API 产生新 jobId。
- 请求使用现有同源和 PostgreSQL 限流门禁；重驱失败不返回内部错误文本。

## 5. 验收

- API 权限、Zod 限制、空队列、固定来源、100 条上限和脱敏响应有自动化覆盖。
- pg-boss 集成测试生成来源为 `resource.process` 的死信任务，重驱后验证任务回到处理队列且不能带走其他来源。
- 设置 UI 显示空态和计数；管理员可重驱受限批次，非管理员不可见操作。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e` 通过。
