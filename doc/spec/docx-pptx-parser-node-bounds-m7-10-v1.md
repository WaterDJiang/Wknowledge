# M7-10-M3 DOCX/PPTX 解析节点边界 Spec v1

## 1. 关联

- 工作包：`M7-10` 安全复扫；关联 `M2-02` Office ZIP 准入、`M4-02` PPTX Shape 回源、`M7-10-J/L/K` 的解析/Worker 资源边界。
- 发现来源：XLSX/CSV 已有行列和单元格上限，但 DOCX 段落与 PPTX 幻灯片/Shape 可在合法 Office ZIP 内无限增多；Python 解析会累积所有派生节点，单一任务可能长期占用 Worker。
- 影响面：Python DOCX/PPTX 派生节点；不改变 Office ZIP 的写入前安全检查、PPTX Shape/备注 Locator 或合法内容的既有顺序。

## 2. 目标

- DOCX 与 PPTX 在输出前具有明确、稳定的结构预算。
- 超限资料不发布部分 compiled/Wiki 节点，稳定以解析限制码失败并可由既有任务错误流程呈现。

## 3. 规则

- DOCX 最多读取 10,000 个段落并最多产出 10,000 个非空节点；超过任一项退出 `DOCX_NODE_LIMIT`。单段正文最大 32 KiB，超出时保留 UTF-8 边界截断和 metadata 标识。
- PPTX 最多 500 页、每页 1,000 个 Shape、整份最多 10,000 个文本 Shape/备注节点；超过任一项退出 `PPTX_NODE_LIMIT`。
- 现有 32 KiB Shape/备注截断、文本 Shape/表格/备注节点、稳定 `slide + shapeId` Locator 和顺序保持不变。
- 这些是解析节点和 CPU 的格式级边界；Office XML 的库加载内存仍由 ZIP 准入、Worker cgroup 和后续独立解析容器共同约束，不伪称已实现完整 XML 流式解析。

## 4. 验收标准

- 正常 DOCX/PPTX 回归保持原有节点、Locator 和截断行为。
- 10,001 段 DOCX 在输出前以 `DOCX_NODE_LIMIT` 退出。
- 501 页 PPTX 在输出前以 `PPTX_NODE_LIMIT` 退出。
- 相关 Python parser 测试与全量质量门禁通过。

## 5. 非范围

- Office XML 的低层流式解析、表格/图表/嵌入媒体语义、扫描 OCR、单独容器化 Python Parser、临时磁盘和组织级队列配额。
