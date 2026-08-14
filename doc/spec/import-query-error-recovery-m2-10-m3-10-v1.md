# 导入后检索错误恢复 M2-10/M3-10 修复 Spec v1

## 1. 关联计划

- 工作包：`M2-10 实时处理 UI`、`M3-10 Query`。
- 现场证据：PDF 已生成 compiled 与 Wiki，`wiki:lint` 通过；“DeepSeek是什么？”实际检索成功。
- 已确认错误：上传成功后的前端日志为 `TypeError: Cannot read properties of null (reading 'reset')`，发生在异步 `upload()` 完成后访问 `event.currentTarget`。
- 可观测性缺口：查询 Route 未捕获 Wiki 未就绪或文件读取异常，前端只显示“查询失败”，用户无法区分处理中、权限问题和系统错误。

## 2. 目标

- 上传成功后安全复位表单，不再产生空 `currentTarget` 异常。
- Wiki 尚未发布时，查询 API 返回稳定错误码和可操作建议，不返回未处理异常。
- 查询页面展示服务端错误消息和建议，并提供重试入口。
- 成功查询行为、Markdown-first 检索和来源引用保持不变。

## 3. 范围

### 包含

- 在异步上传开始前保存表单 DOM 引用，成功后使用该引用复位。
- Query Route 捕获文件不存在与一般异常。
- Wiki 未就绪返回 `409 WIKI_NOT_READY`；其他异常返回 `500 QUERY_FAILED`。
- 查询 UI 增加忙碌状态、错误面板、错误建议和再次检索。
- 浏览器复测刚导入 PDF 的上传后页面与实际查询。

### 不包含

- 修改 Wiki 排序、召回算法或使用 LLM 生成答案。
- SSE 自动等待任务完成；仍属于后续 M2-07/M2-10 切片。
- PDF 原文件预览和页码高亮。

## 4. 验收标准

- 上传成功后浏览器不再新增 `reading 'reset'` 错误。
- 未发布 Wiki 的空间查询返回 409、`WIKI_NOT_READY` 和“等待处理完成后重试”建议。
- 其他查询异常使用统一 `ApiError`，不泄露服务器绝对路径或堆栈。
- 查询失败时页面显示具体消息和建议，按钮恢复可用。
- 查询成功时页面清除旧错误并显示答案与来源。
- 刚导入的 DeepSeek PDF 通过 Wiki Lint，查询“DeepSeek是什么？”成功。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 通过。
