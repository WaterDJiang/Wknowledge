# M2-01 分片上传与续传协议 v1

## 目标

让 8 MiB 以上、100 MiB 以下的受支持资料可在浏览器以可校验的分片上传。文件只在全部分片齐全、完整 SHA-256 与基础文件准入校验通过后，才创建 `Resource`、不可变 `ResourceVersion`、`ProcessingJob` 和 Outbox。

关联工作包：`M2-01`。本分片不改变原始文件不可变、PostgreSQL 管状态、BlobStore 管文件和 Worker 执行解析的边界。

## 范围

- 创建上传会话：文件名、MIME、大小、完整 SHA-256、编译模式；服务器固定 4 MiB 分片和 24 小时过期时间。
- 创建会话前按完整申报大小原子预留组织容量，并在本地部署时预检受管 Blob 卷；过期、重复最终化或正常完成都会释放预留，详细计量规则见 `storage-quota-reservations-m2-01-m2-11-v1.md`。
- 上传分片：按序号和预期长度写临时 Blob；重复同内容分片幂等，内容不同返回冲突。
- 查询会话：仅创建者在仍有空间 editor 权限时可读取已接收分片，用于续传。
- 完成上传：控制面只校验分片是否齐全、将会话原子转为 `finalizing` 并写 `resource.upload.finalize` Outbox；Worker 才拼接、校验大小/SHA-256/文件签名、合成不可变 Blob，并创建 Resource/Version/`resource.process` Outbox。
- 小于等于 8 MiB 的既有 multipart 上传保留，继续走同一份基础文件准入。
- 资料页把上传状态与既有处理任务列表拆为稳定组件：大文件显示上传百分比和“正在校验入库”，失败后在保留文件选择的当前页面再次提交可续传缺失分片。

## 非范围

- 并发上传数量、空间或用户子配额。
- 孤儿不可变 Blob 巡检与深度 ZIP/Office 安全检查（M2-02/M2-04）。
- 断网后跨浏览器重选原文件、服务端上传会话列表、S3 multipart 直传。

## 契约与状态

```text
POST /api/spaces/{spaceId}/uploads
  -> open uploadId, partSize, totalParts, receivedParts, expiresAt
PUT /api/uploads/{uploadId}/parts/{partNumber}
  -> open upload progress；重复同 SHA 返回 duplicate=true
GET /api/uploads/{uploadId}
  -> open/completed 状态和 receivedParts，供同页续传
POST /api/uploads/{uploadId}/complete
  -> 202 upload-finalize ProcessingJob，或 200 duplicate；资源由 Worker 最终化后创建
```

- `resource_upload` 和 `resource_upload_part` 只保存会话、哈希、分片大小、临时 URI、容量预留关联和完成关联；不保存文件正文。
- 状态仅允许 `open → finalizing → completed`；读写时发现过期，将会话标为 `expired` 并返回 `UPLOAD_EXPIRED`。`aborted` 保留给后续主动取消/清理任务。
- 分片大小固定 4 MiB；非最后分片必须恰好等于该大小；最大文件 100 MiB，因此最多 25 片。
- 创建和分片写入必须再次验证登录、同源、创建者身份和空间 `editor` 权限；不得通过 uploadId 泄露跨空间会话。
- 完成前不得创建资源或 ResourceVersion；完成请求只创建最终化任务与 Outbox。Next.js Route Handler 只接收数据、写状态与入队，不读取或拼接全部文件；Worker 执行最终化、解析和 Wiki 编译。

## 错误

| Code                        | 含义                                    |
| --------------------------- | --------------------------------------- |
| `UPLOAD_SESSION_INVALID`    | 请求字段或 SHA-256 格式不合法           |
| `UPLOAD_NOT_FOUND`          | 会话不存在或不属于当前用户              |
| `UPLOAD_NOT_OPEN`           | 会话已完成、已中止或不能再写入          |
| `UPLOAD_EXPIRED`            | 会话超过 24 小时，需重新创建            |
| `UPLOAD_PART_RANGE_INVALID` | 分片序号超出范围                        |
| `UPLOAD_PART_SIZE_INVALID`  | 分片实际字节数不符合预期                |
| `UPLOAD_PART_CONFLICT`      | 同一序号已保存不同内容                  |
| `UPLOAD_INCOMPLETE`         | 仍缺少分片，不能完成                    |
| `UPLOAD_HASH_MISMATCH`      | 拼接文件的 SHA-256 与创建会话时不一致   |
| `STORAGE_QUOTA_EXCEEDED`    | 组织可用存储额度不足，未创建会话或 Blob |

基础准入错误继续使用 `UPLOAD_NAME_INVALID`、`UPLOAD_MIME_UNSUPPORTED`、`UPLOAD_MIME_MISMATCH` 和 `UPLOAD_SIZE_INVALID`。

## 验收

- 12 MiB 支持文件可创建 3 个分片，会话显示已接收分片；中断后使用同一个 uploadId 重传缺失分片并成功完成。
- 重传相同分片不产生第二个临时对象或第二个业务资源；不同内容分片返回 `UPLOAD_PART_CONFLICT`。
- 缺失分片、错误长度、错误完整 SHA 或错误 PDF/Office 签名均不创建 Resource、Job 或 Outbox。
- 完成请求返回 202 最终化任务；Worker 成功后资源与既有上传一样进入 `queued`，再由资源 Worker 处理。完成重复调用不新增最终化或资源处理任务。
- 超额会话在任何 Blob、Resource、Version、Job 或 Outbox 写入前返回 507；并发会话最多一个获得剩余额度。过期会话释放预留后可创建替代会话。
- 未登录为 401；非创建者或无空间权限不泄露会话；请求通过同源与限流保护。
- 单元、数据库/API 与浏览器上传进度验证通过；过期 `open` 与终态 `failed` 会话由 Worker 安全清理临时分片，最终化重试耗尽或确定性校验失败会显示可操作终态。本地 Blob 容量预检已验证；告警仍未实现。
