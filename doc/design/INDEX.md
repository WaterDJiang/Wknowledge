# design/ 索引

进入设计域先读总体设计，再按当前工作包读取一个分域设计；ADR 只记录关键不可逆决策。

## 总体与分域设计

| 设计域       | 状态 | 内容                                           | 文件                                                               |
| ------------ | ---- | ---------------------------------------------- | ------------------------------------------------------------------ |
| 总体架构     | 稳定 | 控制面、执行面、知识面、状态机与故障边界       | [system-architecture-v1.md](system-architecture-v1.md)             |
| 领域数据/API | 稳定 | 聚合、目标表、API、版本、迁移与审计事件        | [domain-data-api-v1.md](domain-data-api-v1.md)                     |
| 知识流水线   | 稳定 | 上传、解析节点、Wiki、查询、浏览与来源预览     | [knowledge-pipeline-v1.md](knowledge-pipeline-v1.md)               |
| 智能运行时   | 稳定 | 多轮会话、知识上下文、Skill、权限、沙箱和模型  | [agent-skill-model-runtime-v1.md](agent-skill-model-runtime-v1.md) |
| 学习应用     | 稳定 | 内容选择、计划、原文、练习、评分、报告和掌握度 | [learning-application-v1.md](learning-application-v1.md)           |
| 安全运维     | 稳定 | 信任边界、部署、密钥、审计、备份和升级         | [security-operations-v1.md](security-operations-v1.md)             |

## ADR

| ADR  | 状态 | 决策                                        | 文件                                                                         |
| ---- | ---- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| 0001 | 接受 | Markdown-first LLM Wiki，向量只能是派生缓存 | [0001-markdown-first-wiki.md](0001-markdown-first-wiki.md)                   |
| 0002 | 接受 | TypeScript 全栈 + Node Worker，无 FastAPI   | [0002-typescript-fullstack-runtime.md](0002-typescript-fullstack-runtime.md) |
| 0003 | 接受 | 所有知识与学习证据使用 SourceLocator        | [0003-source-traceability.md](0003-source-traceability.md)                   |
