# 任务取消、恢复与失败待处理 M2-06 Spec v1

## 1. 关联计划

- 工作包：`M2-06 任务韧性`，补齐已验证 retry 切片后的 cancel、resume 与失败待处理基础能力。

## 2. 目标

- 编辑者可以取消尚未完成的资料处理任务，并在安全点终止 Worker 后续写入。
- 已取消任务可以用同一 `ProcessingJob` 和不可变 `ResourceVersion` 恢复处理；不能用恢复覆盖已完成或失败的任务。
- Worker 的实际 pg-boss 任务 ID 可追踪，供取消、恢复和故障诊断使用，但不暴露给客户端。
- 失败任务保留为“失败待处理”，现有“重新处理”继续创建新的 jobId，不与“恢复已取消任务”混用。

## 3. 范围

### 包含

- `processing_job` 增加内部 `queue_job_id`；状态增加 `cancel_requested`、`cancelled`。
- `POST /api/jobs/{jobId}/cancel` 和 `POST /api/jobs/{jobId}/resume`，均要求空间 `editor` 角色。
- queued 任务取消后立即进入 `cancelled`；processing 任务进入 `cancel_requested`，Worker 在解析、编译前后的安全点确认并落为 `cancelled`。
- Worker 接收 pg-boss AbortSignal；Python 子进程接受 signal，取消后不得继续 Wiki 编译或标记 completed。
- 恢复优先调用 pg-boss resume；队列任务不存在时重新发布并更新内部 queue job ID。
- 资料页展示“取消处理”“正在取消”“恢复处理”“失败待处理”，SSE 可消费新状态。
- 回归覆盖状态机、错误角色、Worker 安全点和 PostgreSQL/pg-boss 队列调用边界。

### 不包含

- 文件解析过程的字节级 checkpoint、任意阶段从中间位置续跑。
- dead-letter 全局运维控制台、失败原因聚类、批量重驱和 outbox（归属 M2-04/M2-11）。
- 取消后删除原始文件、compiled 产物、历史 Wiki 或审计记录。

## 4. 状态机

```text
queued → cancelled → queued
queued → processing → completed
queued → processing → cancel_requested → cancelled → queued
queued/processing → failed
failed → 新 ProcessingJob（现有 retry）
```

- `cancel` 仅接受 `queued`、`processing`；重复或终态请求返回 `409 JOB_NOT_CANCELLABLE`。
- `resume` 仅接受 `cancelled`；其他状态返回 `409 JOB_NOT_RESUMABLE`。
- `cancel_requested` 不是终态：页面仅展示取消中，不允许恢复或重新处理。
- 同一 ResourceVersion 只能有一个 `queued`、`processing` 或 `cancel_requested` 任务。

## 5. 验收

- 未登录 401、无编辑权限 403、未知任务 404；状态冲突为 409。
- 取消不创建新 ResourceVersion，不改 raw 文件，不清除失败证据。
- queued 取消后 Worker 即使收到重复投递也不执行；processing 取消后不继续 Wiki 编译。
- 恢复同一 cancelled jobId，资源回到 queued，队列任务存在或重新发布后可由 Worker 接管。
- failed 继续使用“重新处理”，创建新 jobId；`cancelled` 不显示“重新处理”。
- format、lint、typecheck、test、build 和授权 API E2E 通过。
