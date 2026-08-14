# 内置 Skill

- `wiki-compile`：标准节点编译为 Markdown。
- `wiki-query`：索引优先的非向量查询。
- `wiki-lint`：发布前门禁。
- `wiki-correct`：只生成待确认更正，不覆盖人工审核内容。

`skill.json` 是运行时契约；入口文件哈希写入 `digest`。所有上传内容都按不可信数据处理。
