# Agent 运行事件重放 M5-11 Spec v1

## 1. 目标

- 为 AgentRun 保存最小、可跨进程读取的生命周期与受管 ToolCall 阶段事件，并提供带 `Last-Event-ID` 的只读 SSE 重放接口。
- 刷新页面后由既有 `AgentMessage`、`AgentRun`、EvidenceSnapshot 和 ToolCall 恢复最终回答与来源；事件日志只说明“开始、请求/完成工具、完成/失败/停止”，不保存问题、助手正文、EvidenceBundle、模型提示词、原始路径或 Blob URI。
- 本切片不伪造恢复中的 token delta，不让请求进程恢复已中断的模型调用，也不承担 Worker Skill 事件总线。

## 2. 范围

```text
agent_run_event
  run.started
  tool.requested
  tool.completed
  run.completed | run.failed | run.stopped

GET /api/agent-runs/{runId}/events
  Last-Event-ID: {sequence}
```

- 每个事件有 Run 内单调 `sequence`；客户端可从事件 ID 之后重放。重放只返回已持久化事件后结束，不保持长连接。
- `run.started` 与终态在对应领域事务中原子写入；工具阶段在 Run 仍为 running 时追加。终态后不能追加工具事件。
- API 仅允许会话所有者读取；不存在或他人 Run 按未找到处理。

## 3. 数据规则

- payload 是固定的脱敏结构：工具事件只记录 `tool` 与固定输入/输出摘要；终态只记录 `status`。不把 assistant delta、用户消息、证据正文或来源 URI 再写进事件表。
- 一条 Run 最多一个 `run.started`、一个 `run.completed/run.failed/run.stopped`；`tool.requested` 和 `tool.completed` 可按工具名追加，但本期仅 `knowledge.search/read`。
- 事件记录是历史审计：后续撤权、课程归档或 Binding 移除不改写已完成 Run 的事件；新读取仍必须重新授权。

## 4. 验收

- 开始、两个 ToolCall 阶段和终态的 sequence 连续、可按 Last-Event-ID 读取；completed/failed/stopped 不会再产生工具事件。
- 事件 JSON 不含用户问题、助手正文、Wiki 摘录、`wk://`、Blob URI、真实路径或答案键。
- 非会话所有者和未登录访问被拒绝；已完成 Run 的重放不执行模型、Skill、Wiki 或 Embedding。
- 迁移、契约、数据库状态机、API 未登录 E2E、格式、Lint、类型、测试、构建和 E2E 全部通过。
