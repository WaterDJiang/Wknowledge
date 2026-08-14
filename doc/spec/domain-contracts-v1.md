# Wknowledge 领域契约 v1

## 核心对象

Organization · User · Membership · KnowledgeSpace · Resource · ResourceVersion · ProcessingJob · WikiPage · SourceLocator · Skill · SkillRun · ModelProvider · LearnerProfile · LearningPlan · Course · Assessment · Attempt · MasterySnapshot

## 资源与版本

- `Resource` 是用户看到的逻辑资料。
- `ResourceVersion` 是不可变原件及其哈希、MIME、大小和受管 URI。
- 派生内容按资源版本隔离，不在版本之间共享可变目录。
- 逻辑删除只隐藏资源；真实删除需独立保留策略和审批。

## SourceLocator

`SourceLocator` 是 Wiki、回答和题目引用原文的唯一方式。所有变体都必须带 `resourceVersionId`。

| type        | 定位字段        |
| ----------- | --------------- |
| pdf         | page, bbox?     |
| audio/video | startMs, endMs  |
| sheet       | sheet, range    |
| slide       | slide, shapeId? |
| document    | nodeId          |
| image       | bbox?           |

URI 表示例：`wk://resource/{resourceId}/version/{versionId}#page=12`。

## CompiledNode

- `CompiledNode v1` 是 Parser、Worker、Wiki 和未来多模态能力的唯一中间契约。
- 必填：`schemaVersion/id/kind/content/order/locator/metadata`；可选：`title/parentId`。
- `kind` 只能为 `heading/paragraph/table/image/slide/transcript`。
- 同文档的 ID 和 order 唯一，父节点早于子节点，所有 Locator 指向同一 ResourceVersion。
- `nodes.json` 保存可重建的正文节点；`parser-manifest.json` 保存 Parser ID、版本、运行时、MIME 和生成时间。

## Wiki 契约

- 页面 `schemaVersion` 固定为 `1`。
- 稳定 `id` 不因文件名或标题修改而变化。
- 必填：`id/title/type/status/aliases/tags/sourceRefs/related/sourceMarking/humanVerified/lastCompiled`。
- `sourceMarking` 只能为 `extracted/synthesized/ai_completed`。
- 人工确认页面只能生成候选 diff，不能直接改写。
- 每次发布必须追加 `wiki/log.md` 并更新索引。

## Skill 契约

- Manifest 是版本化的 JSON/YAML 文件，执行时验证摘要。
- 输入输出使用 JSON Schema，超时、内存、模型调用次数必须有上限。
- 默认无网络、无整库权限、原始资源只读。
- 用户上传内容永远是不可信数据，不得改变执行策略。

## 模型契约

- Provider 按能力注册，不假设同一供应商支持所有端点。
- 知识空间数据策略先于成本和质量路由。
- 密钥只保存加密密文，运行日志只记录 Provider ID 与模型 ID。
- Embedding 可注册但不得进入 v1 Wiki Query 链路。

## 学习契约

- `LearnerProfile` 分离 declared/observed/inferred 数据。
- `LearningPlan` 使用不可变版本，draft 只有经用户确认才转 active。
- `Question` 必须保存知识点、来源、标准答案与评分规则。
- `Attempt` 和 `LearningEvent` 追加式写入，更正以新事件表达。
