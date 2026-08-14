# 任务重试与恢复 M2-06 实施 Spec v1

## 1. 目标

- 失败任务保留错误证据，用户可从资料页发起一次新的处理任务。
- 重试复用不可变 ResourceVersion，不重新上传或覆盖原始文件。
- 新任务拥有独立 jobId；旧任务保持 failed，便于审计。

## 2. 本轮切片

### 包含

- `POST /api/jobs/{jobId}/retry`，仅 editor 以上且原任务为 failed 时允许。
- 同一 ResourceVersion 已有 queued/processing 任务时拒绝重复重试。
- 创建新 ProcessingJob、把资源恢复为 queued 并发布 `resource.process`。
- 入队失败时把新任务和资源标记为 failed，保留 `QUEUE_PUBLISH_FAILED`。
- pg-boss 尚可自动重试时，数据库任务保持 `queued` 并使用 `retry_wait` 阶段；耗尽次数后才进入 `failed`。
- 资料页失败卡片显示“重新处理”，重试后自动恢复 SSE 跟踪。
- 未实现的音视频 MIME 在入队前明确拒绝。
- 前端错误摘要不返回 Worker 命令行、堆栈或服务器文件路径。

### 不包含

- dead-letter 管理 UI。
- cancel/resume 检查点和 Worker 进程崩溃注入。
- 数据库 outbox；仍归属 M2-04。

## 3. 验收标准

- 未登录重试返回 401，无空间编辑权限返回 403。
- 非 failed 任务返回 409 `JOB_NOT_RETRYABLE`。
- 重复点击或已有活跃任务返回 409 `JOB_RETRY_ALREADY_ACTIVE`。
- 重试生成新 jobId，旧 job 状态不变，ResourceVersion ID 不变。
- 损坏 PDF 可以稳定触发 failed；点击重试后出现新 queued 任务并再次由 Worker 接管。
- 可自动重试的中间失败不暴露人工重试入口，最终失败后才可创建新任务。
- 对外任务错误不包含 `/Users/`、`Traceback`、解析器脚本或 Blob 路径。
- 音视频上传在 M4 完成前返回 `UPLOAD_MIME_UNSUPPORTED`，不创建资源和任务。
- format、lint、typecheck、test、build 和浏览器失败/重试交互通过。
