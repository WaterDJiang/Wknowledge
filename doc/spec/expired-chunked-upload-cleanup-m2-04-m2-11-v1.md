# M2-04/M2-11 过期分片临时文件清理 Spec v1

## 1. 关联计划

- 工作包：`M2-01 上传协议`、`M2-04 事务补偿`、`M2-11 故障测试`。
- 补齐已过期、未完成分片上传留下临时 Blob 的生命周期缺口；不改变原始证据不可变和 Worker 不在 Next.js 请求进程执行长任务的边界。

## 2. 目标

- Worker 启动时及每 5 分钟清理已过期且不在最终化中的上传会话临时分片。
- 先把 `open` 会话原子转为 `expired` 并释放其容量预留，再删除受该会话记录引用的临时 Blob。
- 物理删除失败时保留分片元数据，以便下一轮安全重试；日志只记录计数，不记录 URI、路径、文件名或内容。

## 3. 规则

- 仅处理 `open`、`failed` 或 `expired` 且 `expiresAt <= now` 的会话；`finalizing`、`completed` 和 `aborted` 会话绝不由该任务删除。
- 删除前将待处理会话行锁定；分片写入在写 Blob 后再次校验会话仍为未过期 `open`，避免过期清理与上传写入产生孤儿。
- `resource_upload_part` 元数据只在对应临时 Blob 删除成功后删除；重复执行对已删除分片无副作用。
- 清理只调用 `BlobStore.removeTemporary`，不可读写不可变 Blob、`raw/`、compiled、Wiki、ResourceVersion 或 ProcessingJob。
- 自动重试中的 `finalizing` 会话不属于本自动清理范围；最终化已终态失败后，会话在原到期时间到达后进入本清理范围，避免与活跃 Worker 竞争。

## 4. 影响面

- `packages/core`：过期会话的锁定、预留释放、临时分片重试删除和计数结果。
- `apps/worker`：启动及定时调用，异常仅记录脱敏计数并不终止资源处理 Worker。
- `packages/core/tests`：过期清理、预留释放、元数据仅在删除成功后移除、重复清理和写入竞争保护。

## 5. 验收

- 过期 `open` 会话及其已记录临时分片被标为 `expired`、删除 Blob/元数据并释放 reservation；不创建 Resource、Version、Job 或 Outbox。
- 临时删除首次失败时元数据仍存在；下次成功时才删除元数据。
- 已过期或已清理会话的分片写入不会留下临时 Blob 或数据库分片记录。
- `finalizing` 会话不会被此任务删除；`failed` 会话仅在到期后清理。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 和 `pnpm test:e2e` 通过。

## 6. 非范围

- 用户主动取消、删除会话行、S3 生命周期规则、临时目录磁盘余量预检和管理员手动清理 UI。
- `finalizing` 失败会话的风险隔离、队列终态回收和不可变 Blob 孤儿自动修复。
