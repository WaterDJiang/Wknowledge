# M2-11 存储容量失败与恢复 Spec v1

## 1. 关联计划

- 工作包：`M2-11 故障测试`，依赖 `M1-07 BlobStore`、`M2-01 上传协议`、`M2-04 Outbox` 与 `M2-06 任务韧性`。
- 当前范围：将本地 Blob 写入和 Worker 派生文件写入的“设备无空间”错误归一为稳定、脱敏、可操作的失败结果。

## 2. 目标

- 操作系统 `ENOSPC`、`EDQUOT` 和 BlobStore 等价错误统一为 `BLOB_STORAGE_FULL`。
- 直接上传/分片写入/分片合成在写入失败时不创建或发布新的业务对象；HTTP 返回 `507 Insufficient Storage` 和可执行提示。
- 资源 Worker 在写 `compiled/` 或 Wiki 时遇容量错误，保留不可变原文件与任务审计，按既有 retry 策略进入 `retry_wait` 或最终 `failed`，错误码为 `BLOB_STORAGE_FULL`。
- UI 显示“存储空间不足”，而不是 Node 错误、路径或堆栈；管理员释放容量后可使用既有重试入口。

## 3. 规则

- 只分类容量/配额错误，不将权限、只读文件系统、未知 I/O 错误误报为容量不足。
- 不自动删除 `raw/`、已发布 Wiki、历史 compiled 或其他用户资料以换取重试。
- 失败后的临时分片由 M2-04 清理任务处理；组织逻辑配额与预留由关联的 `storage-quota-reservations-m2-01-m2-11-v1.md` 实现，本地写入前容量预检由 `local-blob-capacity-preflight-m2-01-m2-11-v1.md` 实现。
- HTTP 状态 `507` 仅用于确认的容量错误；其余存储故障继续走现有脱敏 500/任务失败路径。

## 4. 影响面

- `packages/blob-store`：将 Node 写入错误转换为领域错误，提供可复用分类函数。
- `apps/web`：直接上传与分片路由返回 `507`。
- `apps/worker`：失败任务保存 `BLOB_STORAGE_FULL`，前端已有失败卡片继续使用重试动作。
- 测试：Blob 错误分类、直接/分片错误映射及 Worker 错误码/脱敏回归。

## 5. 验收

- `ENOSPC`/`EDQUOT` 分类为 `BLOB_STORAGE_FULL`；非容量错误不被错误归类。
- 容量失败的上传响应不包含本地路径、堆栈或原始系统错误文本。
- 容量恢复后用户可以重新提交或重试；不会覆盖不可变原文件。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 和 `pnpm test:e2e` 通过。

## 6. 非范围

- 空间/用户子配额、告警阈值与自动清理策略。
- S3/对象存储供应商的特定配额错误适配。
- Worker 产生大文件时的流式写入重构。
