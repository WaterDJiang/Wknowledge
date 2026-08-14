# M7-10-M1 分片上传流式限额 Spec v1

## 1. 关联

- 工作包：`M7-10` 安全复扫；关联 `M2-01` 分片上传协议与 `M2-11` 存储容量失败。
- 发现来源：M7-10 上传体审阅。分片二进制路由先依赖可缺失或伪造的 `Content-Length`，再用 `request.arrayBuffer()` 读取完整 HTTP body；超大 chunked body 会在应用层大小验证前被无界聚合。
- 影响面：仅 `PUT /api/uploads/{uploadId}/parts/{partNumber}` 的 HTTP body 读取；不改变上传会话、分片大小、哈希、Blob 临时写入或最终化协议。

## 2. 目标

- 分片路由不再调用 `request.arrayBuffer()`。
- 不依赖 `Content-Length` 作为大小限制的唯一依据。
- 在读取总字节超过 `CHUNKED_UPLOAD_PART_BYTES` 时，以稳定 `UPLOAD_PART_SIZE_INVALID` 拒绝，不写入临时 Blob 或数据库分片记录。

## 3. 规则

- 路由从 `Request.body` 的 reader 逐块读取，并在每次读取前检查累计字节；读取上限为 `CHUNKED_UPLOAD_PART_BYTES + 1` 的检测边界。
- 缺失 body 返回稳定 `UPLOAD_PART_BODY_REQUIRED`；超限或最终非预期长度仍返回 `UPLOAD_PART_SIZE_INVALID`。
- `Content-Length` 可以作为快速拒绝，但即使该头缺失、为零或不可信，流式累计限制仍必须生效。
- 当前 `BlobStore.putTemporary` 的契约仍接收 `Uint8Array`，因此单个合法 4 MiB 分片会在通过限制后被一次性持有；本切片不声称实现端到端零缓冲或 BlobStore 流式写入。

## 4. 验收标准

- 由多个 body chunk 组成、总长恰为 `CHUNKED_UPLOAD_PART_BYTES` 的输入保留原始字节并通过读取帮助函数。
- 缺失或伪造 `Content-Length` 的超限输入在读取到超过上限时返回 `UPLOAD_PART_SIZE_INVALID`。
- 超限路径不调用 `putChunkedUploadPart`；既有核心层的精确分片长度、hash 和冲突校验保持不变。
- 路由文件不含 `request.arrayBuffer()`；定向与全量质量门禁通过。

## 5. 非范围

- 小文件/替换资料的 multipart 流式解析；它们目前依赖 Next.js `request.formData()`，需要反向代理 body 限额或专门 multipart parser 后另行交付。
- BlobStore 的真正流式临时写入、HTTP 入口代理的请求体上限、上传总量配额、浏览器大文件人工验收。
