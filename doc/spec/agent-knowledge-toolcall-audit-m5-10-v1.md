# Agent 受管知识 ToolCall 审计 M5-10 Spec v1

## 1. 目标

- 将每轮 Agent 已有的 Markdown-first 检索与命中页的受控二次读取显式记录为 `knowledge.search`、`knowledge.read` ToolCall；不接受模型或客户端任意指定路径。
- ToolCall 只记录稳定的 AgentRun、Binding ID、工具名、脱敏摘要、结果数量、检索页数、耗时和完成时间；不写入用户问题正文、Wiki 正文、原始文件路径、Blob URI、模型提示词或答案键。
- 历史对话可在会话所有者权限下读取自己的 ToolCall 元数据；数据库不能为其他用户或非该 Run 创建 ToolCall。

## 2. 范围

- 工作包：`M5-10`，依赖已验证的 `M5-12` 受管 Binding、M5-02 Run 状态机和 EvidenceSnapshot。
- 实现 `knowledge.search` 与 `knowledge.read` 的成功完成快照。`knowledge.read` 只能读取本轮 `knowledge.search` 已命中的 stable page ID，并将每页正文裁剪为受控片段；模型工具调用、多步骤 Agent Loop、跨进程事件重放与第三方 Agent Adapter 留待后续 M5-10/M5-11。
- ToolCall 不读取数据库或 Blob；运行时仍通过 `wiki/index.md → 分域 index → 页面 → compiled` 查询，Embedding 固定为 0。

## 3. 契约

```ts
interface AgentKnowledgeToolCall {
  id: string;
  agentRunId: string;
  name: "knowledge.search" | "knowledge.read";
  bindingIds: string[]; // 当轮已经重授权的 Binding
  inputSummary: string; // 固定、无正文的“在 N 个受管范围中检索”
  outputSummary: string; // 固定、无正文的“检索 P 页，得到 R 条候选”
  resultCount: number;
  searchedPages: number;
  durationMs: number;
  completedAt: string;
}
```

- ToolCall 只能在 `AgentRun` 仍为 `running` 时，与 assistant message、EvidenceSnapshot 的完成事务一起创建；失败/停止 Run 不保存半成品 ToolCall。每轮必须恰好有一条 `knowledge.search`，至多一条 `knowledge.read`。
- `bindingIds` 必须全部来自本轮 `resolveAgentSessionContext` 已授权 Binding；Run 完成前再检查 ID 集合无重复且不超过 8。
- 调用方只能提交服务端构造的元数据，不接受用户输入的 Tool 名、路径、Binding、摘要或结果数量。
- `GET /api/agent-sessions/{sessionId}` 仅向会话所有者返回该会话 Run 的 ToolCall；历史 ToolCall 永不被课程、页面或空间权限后续变化改写。
- 对话页按固定顺序展示当前轮和历史轮的 `knowledge.search → knowledge.read` 脱敏轨迹；它展示工具状态，不用工具摘要替代来源、证据或回答正文。
- 当前轮工具请求在 UI 中区分“检索已绑定范围”和“阅读已检索依据”；两者都不表示模型获得任意路径、整库正文或新的知识范围。

## 4. 验收

- 对空间/页面/版本/Course Binding 的一轮成功查询保存一条 `knowledge.search` 和至多一条 `knowledge.read`；Binding、计数与 EvidenceBundle 一致，且 ToolCall 不含问题或正文。
- 停止、失败、重复完成和非会话所有者均不能新增或读取 ToolCall。
- 页面/版本/Course filter 在 ToolCall 前已经生效；范围外资料不进入 ToolCall 结果、EvidenceBundle、模型上下文或来源快照。
- 自动化覆盖持久化、隐私、状态机和会话读取；迁移、格式、Lint、类型、数据库测试、构建和 E2E 通过。
- 当前轮收到多个 Tool 事件时，页面不覆盖前一个步骤；历史记录即使 ToolCall 完成时间相同，也稳定按 `search → read` 呈现。
