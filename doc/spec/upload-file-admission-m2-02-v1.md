# M2-02 上传文件准入 Spec v1

## 1. 关联计划

- 工作包：`M2-02 文件安全`，依赖既有 `M2-01` 小文件 multipart 上传与 `M2-03/M2-04` 不可变版本和 Outbox。
- 当前范围：在进入 BlobStore 前补齐文件名、扩展名、声明 MIME、基础签名和 Office ZIP 中央目录的确定性安全检查；不在本切片引入分片协议、配额或真正解压业务内容。

## 2. 问题

- 当前上传只按浏览器声明的 MIME 白名单和字节大小判断，文件名可携带路径样式，PDF/Office 二进制可以伪装为允许 MIME。
- Route 把除不支持 MIME、大小之外的所有上传拒绝统一映射为 500，用户无法区分输入不合法与系统故障。

## 3. 目标

- 在写 Blob、创建 ResourceVersion、ProcessingJob 和 Outbox 之前完成确定性准入检查。
- 文件名只作为展示与受控扩展名来源，禁止路径分隔符、控制字符、空白名和超长名。
- 每种支持类型必须同时满足允许的扩展名、声明 MIME 和基础内容签名；允许的文本格式还必须是无 NUL 的有效 UTF-8。
- DOCX/PPTX/XLSX 必须拥有可解析的单磁盘 ZIP 中央目录、对应 Office 主文档条目，且不包含路径穿越、加密条目或宏条目；条目数最多 5,000、总解压大小最多 200 MiB、单条和总压缩比均最多 100:1。
- 输入类拒绝返回稳定的 400 错误码和用户可执行说明，不创建 Blob、资源、版本、任务或 Outbox。

## 4. 准入矩阵

| 类型     | 扩展名            | MIME                   | 基础签名            |
| -------- | ----------------- | ---------------------- | ------------------- |
| 纯文本   | `.txt`            | `text/plain`           | UTF-8、无 NUL       |
| Markdown | `.md`/`.markdown` | `text/markdown`        | UTF-8、无 NUL       |
| CSV      | `.csv`            | `text/csv`             | UTF-8、无 NUL       |
| PDF      | `.pdf`            | `application/pdf`      | 以 `%PDF-` 开头     |
| DOCX     | `.docx`           | Office Word MIME       | ZIP `PK` 本地文件头 |
| PPTX     | `.pptx`           | Office PowerPoint MIME | ZIP `PK` 本地文件头 |
| XLSX     | `.xlsx`           | Office Excel MIME      | ZIP `PK` 本地文件头 |

错误码：

- `UPLOAD_NAME_INVALID`：文件名不安全、为空或超过 255 个 Unicode 码点。
- `UPLOAD_MIME_UNSUPPORTED`：扩展名或 MIME 不属于首期支持集。
- `UPLOAD_MIME_MISMATCH`：扩展名与 MIME 不匹配，或内容不符合该类型的基础签名。
- `UPLOAD_SIZE_INVALID`：空文件或大于 100 MB。
- `UPLOAD_ARCHIVE_UNSAFE`：Office ZIP 目录无效、包含不安全条目、超出解压限制或缺少对应主文档。

## 5. 影响面

- `packages/core`：纯校验函数与 `uploadResource` 的无副作用前置校验。
- `apps/web`：把输入拒绝映射为 400，保留真实 Blob/数据库/队列异常的 500。
- `packages/core/tests`：文件名、MIME、签名、文本编码、Office 中央目录和无副作用顺序回归。

## 6. 验收标准

- 伪装成 PDF 的非 PDF 字节、伪装成 Office 的非 ZIP 字节、扩展/MIME 不一致和含路径的文件名都被稳定拒绝。
- 每种拒绝发生在 BlobStore、数据库和队列调用之前。
- 合法的 PDF、Office ZIP、UTF-8 文本仍能通过准入并进入既有资源流程。
- Route 对四个输入错误码返回 400，不泄露存储根、系统路径或堆栈。
- 正常 DOCX/PPTX/XLSX 的 ZIP 结构通过；条目数、总解压大小、压缩比、加密、宏、路径穿越和缺失主文档均在 BlobStore 前拒绝。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 和 `pnpm test:e2e` 通过。

## 7. 非范围

- 分片创建/续传/合并、上传百分比、空间配额、磁盘余量与 Blob 孤儿巡检。
- Office XML 语义校验、解压后的 XML 实体限制、PDF 结构深检和真正解压业务内容；这些归入解析器安全切片。
- MIME、文件签名或安全检查失效时对用户原件做删除或修复。

## 8. 2026-08-13 实施记录

- 已实现写入前的 `validateUploadInput`，并由 `uploadResource` 在获取数据库连接前调用。
- 已验证合法 UTF-8 文本、PDF 签名和 Office ZIP 中央目录通过；路径样式文件名、扩展/MIME 不一致、伪 PDF、伪 Office、非法 UTF-8、Office 路径穿越、宏、加密、缺失主文档和压缩比异常稳定拒绝。
- 路由将 `UPLOAD_NAME_INVALID`、`UPLOAD_MIME_MISMATCH` 与 `UPLOAD_ARCHIVE_UNSAFE` 映射为 400，保留未知系统错误为 500。
- 本切片已验证基础准入和 Office ZIP 容量边界；分片、配额、磁盘余量、Blob 孤儿巡检、Office XML 语义安全与 PDF 结构深检仍未实施。
