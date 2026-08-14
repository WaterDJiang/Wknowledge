# Agent 运行事件流与停止 M5-02 Spec v1

## 1. 关联计划

- 工作包：`M5-02`、`M5-10`；依赖已完成的 `M5-00` 运行时 Spike 和进行中的 `M5-01/M5-12` 会话/范围切片。
- 详细计划：[Agent 对话与学习闭环扩展计划](../plan/agent-learning-expansion-v1.md) 第 2.1、5、6.B、8 节。
- 当前状态：开发中。本切片只流式呈现受管 Markdown 查询和有据回答；不执行第三方 Skill、Python、OCR、ASR、资料处理或报告生成。

## 2. 目标

- 用户发起会话问题后，立即看到本轮运行、知识查询阶段、回答增量、完成/失败/已停止状态。
- 用户可以停止仍在运行的本轮；停止后不得再写入助手回答、EvidenceSnapshot 或把运行改写为 completed。
- 刷新会话后，已完成回答和来源可恢复；被停止/失败的运行和用户消息可见，但不伪造助手正文。
- 流式过程不扩展知识范围，不开放宿主机工具，不调用 Embedding，且不把工具摘要或资料正文泄露为系统提示。

## 3. 本轮范围

```text
POST /api/agent-sessions/{sessionId}/runs  (SSE 响应)
POST /api/agent-runs/{runId}/stop
→ agent_run: running | completed | failed | stopped
→ 可恢复的用户消息、最终助手消息与 EvidenceSnapshot
→ 当前运行阶段、停止按钮、失败提示、来源抽屉
```

- 创建运行先持久化 user message 与 `running` run；SSE 只传递当前运行的事件，不把临时 delta 写入数据库。
- 当本轮完成后，服务端在同一事务中写入 assistant message、completed run 与不含正文的证据快照，再发送 completed 事件。
- 从 UI 点击停止时，先持久化 `stopped`，再尝试中止本进程内模型请求；多实例/进程重启时至少在下一安全边界读取持久化状态并拒绝完成写入。
- 当前 `wiki-query` 为同步、轻量的 Markdown 读取；请求处理进程仍不得运行 OCR、ASR、文件解析、Wiki 编译或任何实际 Skill。以后真正耗时的 Tool/Skill 必须改由 Worker，并只把事件投递给此工作台。

## 4. 事件契约

SSE 只允许以下 `event` 名称和 JSON 数据：

```ts
type AgentRunStreamEvent =
  | { type: "run.started"; runId: string; userMessage: AgentMessage }
  | { type: "tool.requested"; runId: string; tool: "wiki-query"; inputSummary: string }
  | { type: "tool.completed"; runId: string; tool: "wiki-query"; outputSummary: string }
  | { type: "assistant.delta"; runId: string; text: string }
  | {
      type: "run.completed";
      runId: string;
      result: GroundedQueryResult;
      run: AgentRun;
      assistantMessageId: string;
    }
  | { type: "run.stopped"; runId: string }
  | { type: "run.failed"; runId: string; code: string; message: string };
```

- `assistant.delta` 只是已持久化回答的显示增量；`run.completed` 才是本轮可恢复真相。
- `inputSummary` 只写“在 N 个已绑定知识空间中检索”，不包含问题、资料正文、路径或模型提示。
- `outputSummary` 只写候选条数与已检索页数，不包含正文、Blob URI 或真实文件路径。
- `run.failed.message` 使用用户可读、脱敏文本；内部错误只写稳定 `code`。

## 5. 状态与停止规则

| 旧状态                   | 动作          | 新状态    | 数据约束                                            |
| ------------------------ | ------------- | --------- | --------------------------------------------------- |
| running                  | 正常完成      | completed | 必须有 assistant message；可保存快照                |
| running                  | 可取消的失败  | failed    | 无 assistant message、无快照；保存稳定错误码        |
| running                  | 用户停止/断开 | stopped   | 无 assistant message、无快照；`AGENT_RUN_CANCELLED` |
| completed/failed/stopped | 再次停止      | 原状态    | 幂等，不得覆盖历史                                  |

- 同一会话同一时间最多一个 `running` run；再次发起返回 `409 AGENT_RUN_ACTIVE`。
- 归档会话、无可用范围、Skill 被停用与输入错误必须在创建 `running` run 前拒绝。
- Stop 仅允许会话创建者调用；不得停止他人 run。`running` run 的用户重新获得页面时显示“正在运行”，但恢复的浏览器不重放旧 SSE delta。

## 6. 影响面

- `packages/contracts`：AgentRun lifecycle 与 SSE 事件 Schema。
- `packages/database`：agent run enum migration。
- `packages/core`：begin / complete / fail / stop 状态机。
- `packages/agent-runtime`、`packages/model-gateway`：取消信号从会话运行传递至模型 HTTP 请求；Wiki 查询只在安全边界检查停止。
- `apps/web`：SSE 路由、停止路由、会话页面运行态。

## 7. 验收标准

- 创建 run 后立即获得 `run.started` 和 `tool.requested`；完成后按 `tool.completed → assistant.delta* → run.completed` 顺序结束。
- 用户停止 running run 后，数据库状态为 stopped、错误码为 `AGENT_RUN_CANCELLED`、没有 assistant message/snapshot；迟到的完成操作返回 `AGENT_RUN_NOT_RUNNING`。
- 另一用户无法读取或停止 run；归档会话和并发 run 被拒绝。
- 所有完成 run 的 `embeddingCalls=0`，每条保存的来源仍是 `wk://`，没有 Wiki 摘录。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e` 通过。

## 8. 明确后置

- `GET /api/agent-runs/{runId}/events` 的跨进程可恢复事件日志、Last-Event-ID、SSE 重放。
- 真实 Provider token-level streaming、并行 Tool、Skill 运行事件、审批和 Worker 投递。
- 会话重命名/搜索、消息裁剪、页面/版本/课程范围。
