# M7-10-M6 文本、PDF 与音频处理资源边界 Spec v1

## 1. 关联

- 工作包：`M7-10` 安全复扫；关联 `M2-02` 文件准入、`M4-01` PDF 精确回源、`M4-05/M5-08` 受管 ASR 与 `M7-10-J/K/L/M5` 的解析/Worker 资源边界。
- 发现来源：标准安全复扫发现文本解析会先读取和解码整份 Blob，PDF 逐页处理无页数预检，音频转写会在 Worker 再复制完整音频字节。这些路径可被单个合规上传占用过多内存或过长 CPU 时间。
- 影响面：Node 文本 Parser、Python PDF Parser、受管音频转写；不改变原始文件不可变、来源定位、视频音轨转写或 Provider 数据策略。

## 2. 目标

- 对文本、PDF 与音频转写分别在读取、解析或调用模型前执行确定性资源预算。
- 资料超出预算时不发布部分 compiled/Wiki 节点，不调用 ASR Provider，并以稳定错误码进入既有任务失败流程。

## 3. 规则

- `text/plain` 与 `text/markdown` 源 Blob 最大 8 MiB；超过时在 UTF-8 解码前返回 `TEXT_SOURCE_SIZE_LIMIT`。
- 文本最多 100,000 行、10,000 个节点，单个标题或段落最大 32 KiB；超过时返回 `TEXT_NODE_LIMIT`。合法内容的标题层级、行范围、顺序与 `document` Locator 保持不变。
- PDF 最多 500 页；打开文档后、遍历页面或文字块前检查 `page_count`，超过时退出 `PDF_PAGE_LIMIT`。既有每页/整份文字块和单块截断限制保持不变。
- Worker 音频 ASR 最大接受 25 MiB 的不可变源文件；以已持久化 `resource_version.byte_size` 在 Blob 读取前检查，超过时返回 `ASR_SOURCE_SIZE_LIMIT`，不得调用 Provider。读取后的 `Uint8Array` 直接作为 `Blob` part，不再做展开复制。
- 上述限额是单任务边界，不替代上传配额、Worker cgroup、临时 tmpfs、Provider 自身大小/时长约束或后续音频流式上传。

## 4. 验收标准

- 超过 8 MiB 的文本在 Blob 解码前被拒绝，Provider/发布均不发生。
- 100,001 行或 10,001 个节点的文本以 `TEXT_NODE_LIMIT` 拒绝；既有普通文本/Markdown Parser 回归通过。
- 501 页 PDF 在文字块遍历前以 `PDF_PAGE_LIMIT` 退出；既有 PDF bbox 回归保持通过。
- 超过 25 MiB 的音频使用版本元数据在 Blob 读取和 Gateway 调用前以 `ASR_SOURCE_SIZE_LIMIT` 拒绝；合规音频仍生成相同时间定位转写节点。
- 定向回归、根质量门禁与安全复扫记录更新。

## 5. 非范围

- PDF 页图渲染、扫描 OCR、音频分段上传或流式 ASR、视频提取音轨上限调整、组织派生资产配额、Provider 回复大小限制和独立 Python 容器。
