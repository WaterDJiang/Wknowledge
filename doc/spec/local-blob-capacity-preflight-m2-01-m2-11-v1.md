# M2-01/M2-11 本地 Blob 容量预检 Spec v1

## 1. 关联计划

- 工作包：`M2-01 上传协议`、`M2-11 故障测试`，补齐本地受管 Blob 卷在写入前的容量诊断。
- 不取代组织逻辑配额、实际写入阶段的 `ENOSPC`/`EDQUOT` 归一，也不引入删除、压缩或宿主机容量管理。

## 2. 目标

- Local BlobStore 在每次临时或不可变 Blob 写入前查询目标卷可用字节；可用容量低于本次字节数时稳定拒绝 `BLOB_STORAGE_FULL`。
- 创建分片会话前用完整申报大小预检本地卷，避免先创建会话和 reservation 后才在首片失败。
- 容量检查失败时不写 Blob、不创建分片会话、Resource、ResourceVersion、ProcessingJob 或 Outbox。

## 3. 规则

- 只读取写入根目录所在文件系统的可用块数和块大小；不扫描文件内容、不记录绝对路径、不修改已有资料。
- 预检是竞争条件下的建议性保障：通过后仍可能因其他进程占用容量而写入失败，既有 `BLOB_STORAGE_FULL` 错误归一仍是最终事实来源。
- 不可变写入、临时分片写入与临时合成写入都执行预检；合成最终仍经不可变写入路径再次检查。
- 仅 `LocalBlobStore` 实现该能力。S3/其他 BlobStore 未声明容量预检时不伪造结果，仍依赖 Provider 写入错误。
- 入参字节数必须为正整数；诊断失败或可用量不足均对外归一为 `BLOB_STORAGE_FULL`，不泄露卷、路径、系统错误或实际剩余空间。

## 4. 影响面

- `packages/blob-store`：暴露可选 `assertWriteCapacity` 能力并在本地写入前调用。
- `packages/core`：分片会话创建支持调用方注入预检，且预检先于容量 reservation 和数据库写入。
- `apps/web`：本地分片会话路由通过受管 Blob 根执行预检；直接/替换上传由 LocalBlobStore 写入路径覆盖。

## 5. 验收

- 模拟容量不足时 LocalBlobStore 的临时/不可变写入返回 `BLOB_STORAGE_FULL`，无文件落盘。
- 分片会话预检失败时不创建 `resource_upload`、`storage_reservation`、Resource、Job 或 Outbox。
- 容量充足的上传、分片会话与最终化回归保持通过。
- 响应保持既有 507 脱敏格式。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 和 `pnpm test:e2e` 通过。

## 6. 非范围

- 磁盘预留、最小安全余量、告警通知、容量趋势、管理后台编辑或自动清理。
- S3/网络存储余量查询，以及依据宿主机剩余空间对组织配额作自动调整。
