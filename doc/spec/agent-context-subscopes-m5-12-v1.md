# Agent 精确知识范围绑定 M5-12 Spec v1

## 1. 关联计划

- 工作包：`M5-12`；依赖已交付的会话、整空间绑定、Markdown-first Query、SourceLocator 与 M5-04/M5-05 Skill Policy。
- 上游设计：[智能运行时](../design/agent-skill-model-runtime-v1.md) 3.2 节、[Agent/学习扩展计划](../plan/agent-learning-expansion-v1.md) 第 2.1、5、6.B 节。
- 当前状态：已验证。课程范围已由后续 [Agent 课程范围 Spec](agent-context-course-scope-m5-12-m6-04-v1.md) 在固定 Course/Unit 快照上实现；本文件仍只定义空间、页面和资料版本三种基础范围。

## 2. 目标

- 用户在 Agent 会话中选择一个已授权知识空间、单个已发布 Wiki 页面或单个不可变 ResourceVersion 作为上下文。
- 服务端为每项选择生成可展示的只读虚拟路径，模型、Skill 与浏览器均不接触服务器路径、Blob URI 或用户电脑路径。
- 每轮查询只读取绑定范围内的 Wiki 页面；指定页面或资料版本外的同关键词内容不得进入 EvidenceBundle、模型上下文、答案或来源快照。
- Skill 的 `selected` resources 与 Agent 查询使用同一 Binding 身份；撤权、移除或对象不再可用时立即阻断后续读取。

## 3. 范围与非范围

本阶段支持三种 Binding：

| scope              | 绑定目标                  | 服务端生成虚拟路径                                   | 检索边界                      |
| ------------------ | ------------------------- | ---------------------------------------------------- | ----------------------------- |
| `space`            | KnowledgeSpace            | `/knowledge/{spaceId}`                               | 当前空间所有已发布 Wiki 页面  |
| `wiki_page`        | WikiPage stable ID        | `/knowledge/{spaceId}/wiki/pages/{pageId}`           | 仅该已发布页面                |
| `resource_version` | 不可变 ResourceVersion ID | `/knowledge/{spaceId}/resources/{resourceVersionId}` | `sourceRefs` 指向该版本的页面 |

不在本阶段范围：

- 手工输入或解析 `/knowledge/...` 字符串、`../`、绝对路径、符号链接、Blob URI、`raw/`、`compiled/` 文件路径。
- 任意 Resource、Resource 最新版本别名或未 ready/已删除版本。
- 课程范围的完整规则；它已由 [Agent 课程范围 Spec](agent-context-course-scope-m5-12-m6-04-v1.md) 独立约束，不能用课程标题或 UI 路由代替范围身份。
- 让模型自行扩大 Binding、读取整个空间、查询数据库或读取原始资料正文。

## 4. 数据与 API 契约

`agent_context_binding` 由当前 `space` 扩展为以下不可变目标快照：

```ts
type AgentContextScope = "space" | "wiki_page" | "resource_version";

interface AgentContextBinding {
  id: string;
  sessionId: string;
  spaceId: string;
  scope: AgentContextScope;
  targetId: string | null; // space 为 null；其余为 stable page/version ID
  label: string;
  virtualPath: string;
  status: "active" | "removed" | "revoked";
}
```

- `targetId` 只能由服务端通过受权对象查验后写入；客户端提交的是结构化 `{ spaceId, scope, targetId? }`，不能提交 `label` 或 `virtualPath`。
- `space` Binding 的 `targetId` 为 `null`，且同一会话只允许一个同空间的整空间 Binding。
- `wiki_page` 与 `resource_version` 可以同时属于同一空间；完全相同的 `{ sessionId, spaceId, scope, targetId }` 不可重复。
- Binding 数量上限仍是 8，按 active Binding 计算。
- 删除仍是逻辑状态变更，既有 Run 的 EvidenceSnapshot 不重写。

首期 API 维持现有端点，并扩展请求体：

```text
POST /api/agent-sessions/{sessionId}/context-bindings
{
  "spaceId": "UUID",
  "scope": "space" | "wiki_page" | "resource_version",
  "targetId": "string | UUID"
}
```

- `space` 不接受 `targetId`；`wiki_page` 只接受 page ID 格式；`resource_version` 只接受 UUID。
- 目标不存在、未发布、跨空间、非 ready、无成员权限或会话归档均拒绝；不能回退为整空间 Binding。
- 返回对象只包含范围标签和服务端生成虚拟路径。

## 5. 运行时与检索约束

每轮 Agent Run：

```text
锁定会话
→ 读取 active Binding
→ 重核当前空间成员资格
→ 重核页面已发布 / 版本属于空间且可回源
→ 对每个 Binding 构造确定性 Wiki filter
→ wiki/index.md → 分域 index → 候选页面 → compiled（仅必要时）
→ 合并 EvidenceBundle
→ 自然语言回答与本轮来源快照
```

- `queryWikiEvidence` 获得可选 server-side filter；过滤在评分、摘要、模型调用与持久化前执行，不能先全空间检索再在 UI 隐藏结果。
- `wiki_page` 只允许其 stable ID；`resource_version` 只允许其 `sourceRefs` 可解析且 `resourceVersionId` 相同的页面。
- 同一页面被多个 Binding 命中时按 `{spaceId,pageId}` 去重；Evidence ID 保持既有稳定“空间 + Evidence”契约，实际范围由运行时不可篡改的 Binding filter、Skill Approval/Run 的 Binding ID 快照共同证明，不向回答暴露新的内部标识。
- 多个 Binding 属于同一空间时，读取空间根索引一次、按 Binding filter 搜索；上限 8 且没有 Embedding 调用。
- 已撤销 Binding 原子标为 `revoked`；没有任何可用 Binding 返回 `AGENT_CONTEXT_UNAVAILABLE`，不调用模型或 Skill。

## 6. UI 交互

- 对话右栏使用“知识范围”选择器：先选择空间，再选择“整个知识空间 / Wiki 页面 / 已处理资料版本”。
- 每项显示范围类型、标题、状态和虚拟路径；默认建议整空间，但用户可删除或新增精确项。
- 页面与资料候选只能来自当前用户有 viewer 权限的空间；资料仅显示 `ready` 的版本及其版本号，Wiki 页面仅显示已发布页面。
- 运行中的“检索中”状态按实际 Binding 标签描述，例如“在《间隔学习》页面中检索”；回答下方来源仍按 EvidenceSnapshot 展示。
- 不提供路径输入框，也不在 UI 显示 data root、Blob、raw、compiled 或数据库标识。

## 7. 验收标准

- 同一空间内建立两个同关键词 Wiki 页面，仅绑定其中一个页面时，EvidenceBundle、答案和 SourceLocator 均只引用该页面。
- 一个资源版本对应多个 Wiki 页面时，`resource_version` Binding 可以检索这些页面，但不会返回其他版本的页面。
- 客户端伪造 `virtualPath`、`label`、`../`、跨空间 page ID、跨空间 version ID 或未 ready 版本全部被 Schema/服务端拒绝。
- 撤销成员资格、移除 Binding、归档会话或目标页面不再发布后，下一轮不读取对应内容；历史 Run Snapshot 仍保留元数据且不复制正文。
- Skill approval 与 SkillRun 传入已移除、已撤权或不匹配 Binding ID 时拒绝；已授权 `selected` Skill 无法扩大到同空间其他页面。
- 查询记录的 `embeddingCalls=0`；依赖树不新增向量数据库客户端。
- 新增单元/集成/API/E2E 覆盖后执行 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 与 `pnpm test:e2e`。

## 8. 后续切片

- `course` scope：以 M6 已确认的 Course/Unit 与其不可变 ResourceVersion/Wiki 页面快照为 target，不读取“当前课程”动态集合。
- `knowledge.list/search/read`：把 Binding filter 作为工具调用不可篡改参数，并为每次 ToolCall 保存 Binding ID 与脱敏输入摘要。
- 跨进程事件重放、上下文裁剪与真实多步骤 Tool Loop 仍归 M5-02/M5-10 后续，不因范围选择器而提前宣称完成。
