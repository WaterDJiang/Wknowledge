# M2-04 任务 Outbox 与队列补偿 Spec v1

## 1. 关联计划

- 工作包：`M2-04 事务补偿`、`M2-05 队列`、`M2-11 故障测试`。
- 解决 PostgreSQL 已提交 Resource/ResourceVersion/ProcessingJob，但 pg-boss 发送失败导致任务永久停留 queued 的一致性缺口。

## 2. 目标

- 创建资源处理任务时，在同一数据库事务创建一条最小化 `job_outbox` 记录。
- Web 请求在事务提交后可立即尝试发送；发送失败不回滚或伪造 ProcessingJob 失败状态。
- Worker 启动及固定间隔补偿待发送消息；每条消息使用短租约，崩溃后可接管。
- 发送成功才记录 `queueJobId` 和 outbox sent；队列重复投递由既有 ProcessingJob execution claim 防重。

## 3. 数据与状态

```text
pending
→ dispatching (dispatchToken + lease)
→ sent (queueJobId + sentAt)

dispatching lease expired → pending candidate
queue send failed → pending + QUEUE_PUBLISH_FAILED
```

- Outbox 仅保存 ProcessingJob ID、ResourceVersion ID、状态、尝试次数、租约、错误码和队列消息 ID；不保存文件正文、Blob 路径、用户上传内容或错误堆栈。
- ProcessingJob 仍是业务任务真相源；outbox 只是可靠投递意图。
- 每个 ProcessingJob 最多一个 outbox 行，数据库唯一约束保证。
- 已取消或已完成任务不会被补偿器重新发送；恢复/人工重试会创建或复用合规的处理投递意图。

## 4. 范围

### 包含

- `job_outbox` Drizzle Schema 与 SQL migration。
- 上传和失败后人工重试把业务任务与 outbox 在同一事务创建。
- Core 的短租约领取、发送确认、失败回退和批量 drain。
- Worker 启动 drain 和周期 drain；Next.js 请求进程不运行周期补偿。
- 数据库回归：队列首次失败后保持 pending、后续补偿成功、并发 drain 只发送一次、过期 dispatching 可接管、取消任务不发送。

### 不包含

- 通用事件总线、Kafka、跨服务 outbox relay、优先级调度、告警通知、批量人工干预 UI。
- Blob 删除补偿、分片上传会话、孤儿 Blob 全量巡检。
- 改变 raw、ResourceVersion 或 Wiki 发布协议。

## 5. 验收

- 队列不可用时上传 API 仍返回已持久化的 `202 jobId`；资源与 Job 为 queued，outbox pending。
- 任意一次后续 Worker drain 成功后，outbox sent，ProcessingJob 获得 queueJobId。
- 同一 outbox 并发 drain 和进程崩溃后接管不会产生两次 Core `publish` 调用；即使 broker 在确认前发生不确定结果，Worker execution claim 保证同一 ProcessingJob 不被并发执行。
- 取消/完成的任务不会由过期 outbox 重新进入队列。
- `pnpm db:migrate && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e` 通过。
