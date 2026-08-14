# M2-01/M2-04/M2-06/M2-11 分片最终化失败闭环 Spec v1

## 1. 关联计划

- 工作包：`M2-01 上传协议`、`M2-04 事务补偿`、`M2-06 任务韧性`、`M2-11 故障测试`。
- 补齐分片上传在完整性校验、临时合成或资源处理任务投递失败且 pg-boss 重试耗尽后的可观察终态和安全回收缺口。

## 2. 目标

- `resource.upload.finalize` 每次失败同步记录稳定错误码和安全摘要；可重试故障期间会话保持 `finalizing`，任务为 `queued/retry_wait`。
- 重试耗尽，或遇到完整性、安全或会话过期等确定性故障后，会话原子进入 `failed`（过期会话保持 `expired`），最终化任务进入 `failed`，容量 reservation 立即释放；不创建 Resource、ResourceVersion 或资源处理任务。
- 同一会话读取接口返回失败状态和可操作摘要；资料页停止“校验入库中”轮询并提示用户重新选择文件提交。
- 已失败会话只在原始到期时间后由既有 Worker 清理临时分片；不与活跃最终化 Worker 竞争。

## 3. 状态机与规则

```text
open → finalizing → completed
                 ↘ retry_wait (pg-boss 自动重试)
                 ↘ failed → 到期后清理临时分片
```

- 失败状态仅允许由 `finalizing` 写入；已完成会话的迟到失败不改写结果。
- 对外错误码仅限 `BLOB_STORAGE_FULL`、`UPLOAD_HASH_MISMATCH`、`UPLOAD_PART_SIZE_INVALID`、`UPLOAD_ARCHIVE_UNSAFE`、`UPLOAD_EXPIRED` 或泛化 `UPLOAD_FINALIZATION_FAILED`；不保存 Node 错误、路径、堆栈或原始内容。
- `resource_upload.error_message` 使用稳定用户摘要，不复制底层异常文本。
- `BLOB_STORAGE_FULL` 和未知暂态故障可自动重试；哈希、分片大小、Office 安全和会话过期故障立即终态。终态后立即释放容量预留，但保留分片直至原会话过期，供只读失败诊断和既有清理器处理。
- `failed` 会话不能继续写分片或再次完成；用户重新选择文件创建新会话，不复用失败会话。

## 4. 数据与接口

- `resource_upload_status` 增加 `failed`。
- `resource_upload.error_code`、`resource_upload.error_message` 保存最终化安全错误；不进入 Resource、Wiki 或原始文件。
- 既有 `GET /api/uploads/{uploadId}` 返回上述会话安全字段；无新增公开写接口。

## 5. 验收

- 自动重试中，最终化任务为 `queued/retry_wait`，会话仍为 `finalizing` 且临时分片不被清理。
- 重试耗尽后，会话和最终化任务均为 `failed`、reservation 已释放，错误不包含路径或堆栈。
- UI 在会话完成时进入资料处理；在会话失败时停止轮询并提示重新提交。
- 失败会话在到期前不删除，过期后由临时分片清理器删除；已完成或活跃最终化会话不受影响。
- `pnpm db:migrate`、`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 和 `pnpm test:e2e` 通过。

## 6. 非范围

- 从失败最终化会话人工恢复、重新入队、跨会话断点续传、用户主动取消上传和死信批量管理 UI。
- 临时对象 S3 生命周期、不可变 Blob 孤儿自动删除或磁盘余量预检。
