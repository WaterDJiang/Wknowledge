# 有据自然语言问答 M3-10/M5-02/M5-06 需求 Spec v1

## 1. 产品纠正

- 当前“知识问答”实际是知识检索摘要：读取候选 Wiki 页面后直接拼接原文片段。
- 正确的知识问答必须先检索证据，再由对话模型基于证据生成自然语言回答，最后独立显示源资料。
- 检索结果和模型回答必须分层，不能把模型生成文本伪装成原文。

## 2. 目标流程

```text
用户问题与会话上下文
→ index-first 检索
→ 候选 Wiki 页面与 compiled 节点
→ 证据包 EvidenceBundle
→ 数据策略与 Provider 路由
→ chat 模型生成结构化 GroundedAnswer
→ 引用校验、拒答与安全过滤
→ 自然语言回答
→ 独立来源卡片与定位入口
```

## 3. 核心契约

```ts
interface EvidenceItem {
  id: string;
  text: string;
  pageId: string;
  sourceRefs: string[];
}

interface GroundedAnswer {
  answer: string;
  evidenceIds: string[];
  insufficientEvidence: boolean;
  mode: "generated" | "extractive_fallback";
}
```

- 模型只能引用 EvidenceBundle 中存在的 `evidenceIds`。
- 上传文档中的指令始终作为不可信数据，不能改变系统提示、权限或数据策略。
- 模型输出无法通过 Schema 或引用校验时不得直接展示。

## 4. 模型与降级策略

- `local_only` 只选择本地 chat Provider。
- 云 Provider 只用于允许云处理的空间，并记录 Provider、模型、耗时和成本。
- 未配置可用 chat Provider 时，页面明确标记“检索摘要模式”，不得伪装成自然语言智能回答。
- 模型超时或失败可以降级到检索摘要，同时保留失败原因和 requestId。

## 5. 会话边界

- 第一切片：单轮有据回答、拒答、来源和模型调用记录。
- 第二切片：会话与消息持久化、多轮指代消解、上下文裁剪和会话重命名。
- 历史回答固定引用当时的 Wiki 页面和资源版本，知识更新不能改写历史证据。

## 6. 验收标准

- UI 主体显示自然语言回答，原文证据和源资料在独立区域展示。
- 回答中的每个事实性引用都能解析到 EvidenceItem 和 SourceLocator。
- 证据不足时明确拒答，不用模型常识补齐知识库缺口。
- 文档提示注入不能改变系统指令、调用额外工具或访问其他空间。
- 模型不可用时 UI 明确显示检索摘要模式。
- 查询运行记录中的 Embedding 调用数保持为 0。
