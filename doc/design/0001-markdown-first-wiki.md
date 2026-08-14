# ADR-0001：Markdown-first LLM Wiki

- 状态：接受
- 决策：使用不可变 `raw/`、可重建 `compiled/`、LLM 管理 `wiki/` 和来源 `mappings/`。
- 检索：根索引 → 分域索引 → 标题/别名/标签 → 文本搜索 → 回查 compiled。
- 约束：v1 不引入向量数据库，Embedding 不进入查询链路。
- 后果：知识可审阅、可导出、不绑定检索产品；同义词和规模问题通过 aliases、分域索引和未来可重建缓存处理。
