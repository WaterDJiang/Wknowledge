# M7-10-M9：来源预览范围读取 Spec v1

## 1. 关联

- 工作包：`M7-10` 安全复扫；关联 `M4-08` 来源内容 API 与 `M4-09` 来源预览。
- 发现来源：2026-08-14 标准安全复扫中风险项。`Range` 请求虽正确返回 `206`，但在切片前仍以 `BlobStore.read()` 完整读入原始文件。
- 影响面：`packages/blob-store` Local 实现、`/api/source-locators/content` 与 BlobStore 回归。

## 2. 目标

- 浏览器仅请求来源文件的一段时，服务端只从本地受管 Blob 读取该字节段。
- 保持现有授权、`Range` 语义、私有缓存和下载安全响应头。

## 3. 规则

- Local BlobStore 提供显式 `readRange(uri, start, end)`；参数必须是安全的闭区间整数，读取长度为 `end - start + 1`。
- 使用文件句柄的 position/length 读取，不可调用全量 `read()` 后 `subarray()`；文件实际长度不足、非普通文件或读取不足返回受控错误。
- 来源 API 在已经基于不可变版本 `byteSize` 校验 Range 后调用 `readRange`，返回直接字节视图，避免第二份内容副本。
- Blob URI 仍只允许 `local://`；本切片不定义 S3 实现，但后续生产 S3 Adapter 必须提供等价 Range GET。

## 4. 验收标准

- 对 10 字节 Blob 请求 `2-5` 只返回 4 字节；全量 `read()` 即使被拒绝，`readRange()` 仍正常工作。
- 非法、越界或短读取不返回伪造 `Content-Range`。
- 授权、416、200/206、`Content-Disposition`、私有缓存与 `nosniff` 行为不回退。
- 格式、Lint、类型检查、完整单测、构建与 E2E 通过。

## 5. 非范围

- 通用远程 BlobStore、浏览器端分段缓存、视频转码流、下载限速与原始文件生命周期回收。
