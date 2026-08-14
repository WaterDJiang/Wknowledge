# Agent 会话与知识空间上下文 M5-01/M5-12 Spec v1

## 1. 关联计划

- 工作包：`M5-01`、`M5-12`；以前置完成的 `M5-00` 内部 `AgentCoreAdapter` 为回退基线。
- 依赖：[Agent/学习扩展计划](../plan/agent-learning-expansion-v1.md) 第 2.1、5、6.B、6.C、10 节。
- 当前状态：开发中。本切片不实现页面/版本粒度、SSE/停止、真实 Tool/Skill 执行或 M6 学习业务。

## 2. 目标

- 用户可创建、列出、重命名、归档和恢复私有 Agent 会话。
- 新建会话时显式绑定一个或多个已授权知识空间；服务端为每个绑定生成只读虚拟路径 `/knowledge/{spaceId}`。
- 用户可在同一会话发送多轮问题；每一轮重新验证会话拥有者和每个绑定空间的 viewer 权限。
- 回答只基于绑定空间各自的 Markdown-first Wiki EvidenceBundle；多空间证据以带空间前缀的稳定 ID 合并，Embedding 调用固定为 0。
- 用户消息、助手回答、每轮所用绑定和证据快照持久化；历史快照保留，未来读取受解绑/撤权阻断。

## 3. 本轮范围

```text
AgentSession / AgentContextBinding / AgentMessage / AgentRun
→ 创建、列出、改名、归档/恢复
→ 显式整库空间绑定与虚拟路径
→ 多空间 Markdown 查询 + EvidenceBundle 合并
→ 多轮消息与证据快照持久化
→ `/workspace/assistant` 会话创建、范围添加/移除、归档/恢复与来源展示
```

本切片只接受 `scope: "space"`：

- 可同时绑定 1–8 个知识空间；不允许创建无知识范围的“通用聊天”。
- 绑定只由 `spaceId` 创建；客户端不能提交 `virtualPath`、服务器路径、Blob URI、`..`、Wiki 文件路径或 ResourceVersion 路径。
- 当前消息 API 同步完成 Markdown 查询和有据回答。它不执行 Skill、Python、OCR、ASR、PDF 处理、报告生成或其他长任务；这些能力仍只能由 Worker 在后续工作包执行。

## 4. 数据与权限契约

### 4.1 AgentSession

```ts
interface AgentSession {
  id: string;
  organizationId: string;
  userId: string;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}
```

- 会话只对创建者可见和可写；组织管理员不因管理权限直接取得正文访问权。
- 标题是用户可编辑的短文本；首轮不自动把问题或资料标题写入标题。
- 归档会话不能发送消息或新增绑定；恢复后才可继续。

### 4.2 AgentContextBinding

```ts
interface AgentContextBinding {
  id: string;
  sessionId: string;
  spaceId: string;
  scope: "space";
  virtualPath: string; // /knowledge/{spaceId}
  label: string;
  status: "active" | "removed" | "revoked";
  createdBy: string;
}
```

- 会话同一空间只有一个 binding。
- 创建/查询/每轮消息均要求绑定空间 viewer 权限。失去权限时 binding 标为 `revoked`，不再参与后续检索；用户主动移除则标为 `removed`。
- API 返回虚拟路径和空间标题，不返回资料 Blob URI、数据根目录、服务器路径、SQLite/PostgreSQL 查询或用户设备路径。

### 4.3 Message、Run 与 EvidenceSnapshot

- `agent_message` 只保存用户/助手的会话内容；不复制 Wiki 页正文、compiled 正文、模型提示或密钥。
- `agent_run` 记录当前消息、助手消息、状态、回答模式、耗时、Embedding 次数与错误码。
- `agent_evidence_snapshot` 保存当轮 Evidence ID、空间、Wiki 页面身份/标题/类型、顺序、`wk://` 来源定位、来源数量和实际引用状态；不保存 Evidence 摘录。历史快照可打开当时的历史 ResourceVersion，但不能重新授权正文。

## 5. 多空间查询规则

1. 服务端锁定会话并验证其 `userId`。
2. 读取 active bindings；对每个 binding 重新执行 `requireSpaceRole(userId, spaceId, "viewer")`。
3. 无权限 binding 原子标为 `revoked` 并从本轮排除；如果没有可用 binding，返回 `409 AGENT_CONTEXT_UNAVAILABLE`，不调用模型。
4. 对可用空间并行读取 `wiki/index.md → 分域 index → 页面 → compiled`，复用 `queryWikiEvidence`；不调用 Embedding。
5. 证据 ID 由 `{spaceId}__{evidenceId}` 组成并在回答校验前合并。任何答案引用都必须指向本轮合并 EvidenceBundle。
6. 保存用户消息、run、助手消息和不含正文的 EvidenceSnapshot。事务失败则不返回未审计的助手回答。

冲突空间页面仍携带 `conflicted=true`；回答必须按既有 Grounded Agent 规则提示并列结论。

## 6. API

```text
POST   /api/agent-sessions
GET    /api/agent-sessions
PATCH  /api/agent-sessions/{sessionId}
GET    /api/agent-sessions/{sessionId}
POST   /api/agent-sessions/{sessionId}/context-bindings
DELETE /api/agent-sessions/{sessionId}/context-bindings/{bindingId}
POST   /api/agent-sessions/{sessionId}/messages
```

- 全部 API 要求登录；写操作还要求同源和限流。
- 创建和新增 binding 只接受 UUID `spaceId`，最多 8 个范围。
- `GET` 只返回当前用户拥有的会话，详细结果含消息、binding、run 与证据元数据。
- 内容不存在/未发布的空间可返回 `WIKI_NOT_READY`；它不使会话读取其他绑定外资料。

## 7. 验收标准

- 用户创建含两个已授权空间的会话；多轮消息可恢复，回答证据只来自这两个空间，且 `embeddingCalls=0`。
- 创建时混入无权空间失败，且不会留下半创建会话或 binding。
- 用户无法读取、改名、归档或向他人会话发送消息。
- 解绑后下一轮不再使用该空间；撤销空间成员资格后下一轮自动标记 revoked 并排除。
- 任一手工虚拟路径、`..`、Blob URI 或非 UUID 输入被 Schema 拒绝；服务端统一生成 `/knowledge/{spaceId}`。
- 归档会话不能继续提问；恢复后允许。
- Assistant 消息的每条引用都有同一 run 的 EvidenceSnapshot；快照/API 不含 Wiki 摘录、问题哈希以外的模型提示或密钥。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 通过；用户 UI 完成后才追加相关 E2E。

## 8. 明确后置

- 指定 Wiki 页面、ResourceVersion、课程范围和其服务端路径映射。
- SSE、停止/继续、上下文裁剪和 Tool/Skill 事件。
- `allow/ask/deny`、审批、Sandbox、第三方 Skill。
- 选材、学习计划、原文学习、练习、评分与报告。
