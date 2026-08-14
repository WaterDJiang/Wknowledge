# EvidenceBundle 有据问答基础 M3-10 Spec v1

## 1. 目标

- 把“Wiki 搜索结果”改造成可校验的证据包，而不是直接把页面摘要伪装成回答。
- 统一 Agent、API 和 UI 使用的证据 ID、文本、Wiki 页面与 SourceLocator 契约。
- 未配置可用 chat Provider 时明确进入“检索摘要模式”。
- 为下一切片的真实模型生成、引用校验和调用审计提供稳定输入。

## 2. 目标流程

```text
问题
→ 读取 wiki/index.md
→ 页面和正文相关度检索
→ EvidenceBundle
→ Provider 可用？
   ├── 否：extractive_fallback
   └── 是：generated + 引用校验（下一切片）
→ 回答区
→ 证据摘录区
→ 原资料定位区
```

## 3. 共享契约

```ts
interface EvidenceItem {
  id: string;
  pageId: string;
  pageTitle: string;
  pageType: "concept" | "topic" | "case" | "course" | "material";
  text: string;
  sourceRefs: string[];
}

interface EvidenceBundle {
  question: string;
  items: EvidenceItem[];
  searchedPages: number;
  embeddingCalls: 0;
}

interface GroundedAnswer {
  answer: string;
  evidenceIds: string[];
  insufficientEvidence: boolean;
  mode: "generated" | "extractive_fallback";
}

interface GroundedQueryResult {
  answer: GroundedAnswer;
  evidence: EvidenceBundle;
}
```

- `GroundedAnswer.evidenceIds` 必须是当前 EvidenceBundle ID 的子集。
- `insufficientEvidence=true` 时 `evidenceIds` 必须为空。
- `generated` 预留给真实 chat Provider；本切片只产生 `extractive_fallback`。
- Evidence 文本必须清除内部 `wk://` 字符串和 Markdown 来源行。
- `embeddingCalls` 固定为 0。

## 4. Evidence 构建规则

- 沿用现有中文 2–4 字片段、拉丁完整词、标题加权和相对最低分过滤。
- 一个候选 Wiki 页面生成一个 EvidenceItem。
- EvidenceItem 只保留该页面自身 `sourceRefs`，不得聚合无关页面来源。
- EvidenceItem 文本优先使用命中问题词的正文块，长度上限 500 字符。
- ID 在一次结果中稳定且唯一，格式为 `evidence-01`、`evidence-02`。
- 无候选时返回空 EvidenceBundle，由 Agent 生成明确拒答。

## 5. Agent 与降级

- Agent 的 `wiki-query` 工具输出从旧摘要结果改为 EvidenceBundle。
- 本切片没有真实 Provider，因此所有有证据回答都标记 `extractive_fallback`。
- 降级回答可以组织证据摘录，但不得声称是模型综合回答。
- 上传文档中的命令式文本只属于 EvidenceItem.text，不能成为系统或工具指令。
- Agent Run 响应记录 `modelCall: null`；数据库持久化在 M3-11/M5-06 实施。

## 6. UI

- 回答顶部显示模式：`检索摘要模式` 或 `模型生成`。
- 摘要模式必须说明当前未配置可用对话模型。
- 回答正文、证据摘录、原资料定位分成三个视觉层级。
- 来源按 EvidenceItem 分组，显示页面类型、摘录和定位数量。
- 证据不足时只显示拒答，不渲染空来源区。
- 提交按钮文案使用“提问”，加载状态区分“检索证据”。

## 7. 影响面

- `packages/contracts`：EvidenceBundle、GroundedAnswer、GroundedQueryResult Schema。
- `packages/wiki`：证据检索入口；旧 `queryWiki` 由同一 EvidenceBundle 派生，避免双重检索真相源。
- `packages/agent-runtime`：结构化结果、拒答和 extractive fallback。
- `apps/web`：Query API 响应与问答页面三层展示。
- 本切片不修改数据库，也不增加 Provider 密钥。

## 8. 验收标准

- 命中查询返回至少一个 EvidenceItem，ID 唯一且来源可解析。
- 回答引用 ID 全部属于 EvidenceBundle；伪造 ID 不能通过 Schema。
- Evidence 文本不包含 `wk://` 或 `> 来源：`。
- 无命中时 `insufficientEvidence=true` 且来源为空。
- API 响应显式包含 `mode=extractive_fallback`、`modelCall=null` 和 `embeddingCalls=0`。
- UI 明确显示“检索摘要模式”，不再显示“已完成有据回答”造成模型生成错觉。
- 页面分别展示回答、证据摘录和原资料定位。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e` 通过。

## 9. 后续切片

- 注册和健康检查真实 chat Provider。
- 根据空间数据策略选择 local/cloud Provider。
- 模型输出 Zod 校验和 Evidence ID 子集校验。
- 模型超时、失败和非法引用降级。
- 查询与模型调用记录持久化、费用和耗时审计。
