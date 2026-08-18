# Design 0005：Pi 事件、Tool 与 Session 映射（冻结基线）

- 状态：冻结（S0，2026-08-17）；仅可经 Spec 变更流程修改
- 关联：[ADR 0004](0004-pi-core-component-runtime.md) · [Pi Core 供应链档案](../ref/pi-core-supply-chain-v1.md) · 工作包 `M5-13`/`M5-16`
- 依据：`@earendil-works/pi-agent-core@0.84.2` 实际 `dist/*.d.ts` 与 `@wknowledge/agent-runtime` 既有 `AgentCoreEvent` 契约

本文件冻结 Pi 与 Wknowledge 契约的映射。S1 `PiAgentCoreAdapter` 必须按下表实现；任何一侧不满足映射的 Pi 升级都不得合入。

## 1. 职责边界

```text
Pi Agent (pi-agent-core)          Wknowledge (@wknowledge/agent-runtime)
├─ Agent/agentLoop 对话循环   ->   PiAgentCoreAdapter（反腐层，唯一 Pi 类型入口）
├─ AgentEvent 流             ->   AgentCoreEvent -> AgentRunEvent 持久化 -> SSE
├─ AgentTool                 <-   Tool Registry 注册的 knowledge.* 等窄 Tool
├─ beforeToolCall            <-   Wknowledge Policy/Approval/预算
├─ afterToolCall             <-   结果裁剪、来源挂接、审计、稳定错误归一
├─ StreamFn                  <-   Model Gateway Bridge（唯一 Provider 路由）
└─ 内存 transcript/AgentState X   AgentSession/AgentRun/ToolCall 数据库为业务真相源
```

Pi 类型只存在于 `@wknowledge/agent-runtime` 内部；业务代码继续只依赖 `AgentCoreAdapter` 接口与 `@wknowledge/contracts`。

## 2. 事件映射（Pi AgentEvent -> AgentCoreEvent -> 持久化/SSE）

| Pi 事件 (0.84.2)                                                                            | AgentCoreEvent                                              | AgentRunEvent 持久化                                | SSE 语义                     |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- | ---------------------------- |
| `agent_start`                                                                               | `run.started`                                               | `run.started`                                       | 运行开始                     |
| `message_update` + `assistantMessageEvent.type === "text_delta"`                            | `assistant.delta`（文本增量）                               | 不持久化 delta，`message_end` 后仅记脱敏摘要        | 流式正文                     |
| `message_update` + `assistantMessageEvent.type === "error"`（stopReason `aborted`/`error`） | 归入终态（见下）                                            | —                                                   | 错误/中止                    |
| `tool_execution_start`                                                                      | `tool.requested`（toolCallId、toolName、脱敏 inputSummary） | `run.started` 后追加 `knowledge.search/read` 类事件 | 工具开始                     |
| `tool_execution_end`                                                                        | `tool.completed`（脱敏 outputSummary）                      | 工具状态/计数更新                                   | 工具结束                     |
| `agent_end`（正常，全部 ToolCall 完成）                                                     | `run.completed`                                             | `run.completed`                                     | 结束，可重放 `Last-Event-ID` |
| AbortSignal 触发、Pi 停止原因为 `aborted`                                                   | `run.stopped`（reason=`cancelled`）                         | `run.stopped`                                       | 用户停止                     |
| `agent_end` 前后 Pi/Provider 抛错或 stopReason=`error`/`length`                             | `run.failed`（code 经稳定错误归一表映射）                   | `run.failed`                                        | 可操作错误                   |

规则：

- 每个事件先过 `inputSummary/outputSummary` 脱敏与长度校验（沿用现有 ≤2 000 字符契约），不保存问题、回答正文、证据正文或虚拟路径。
- `tool_execution_update` 不映射为持久化事件；仅用于进度 UI 时由 Adapter 聚合，不落库。
- `turn_start/turn_end`、`message_start/message_end` 不直接外发；多轮内部节奏由 Adapter 折叠为连续 `assistant.delta` 与终态。
- SSE 重放继续以数据库 `AgentRunEvent` 序列为真相源，Pi 内存事件丢失不影响重放。

## 3. Tool 映射（Tool Registry -> Pi AgentTool）

| Wknowledge 侧                       | Pi `AgentTool` 成员                                   | 说明                                                                       |
| ----------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------- |
| Tool Schema（Zod/typebox）          | `parameters` + `prepareArguments`（宽容修复后再校验） | 伪造/越界参数在 Schema 校验处失败关闭                                      |
| Handler（组件 Port 调用）           | `execute(toolCallId, params, signal, onUpdate)`       | 只调用 `KnowledgeComponent` 等窄 Port，不接触数据库/文件/密钥              |
| 脱敏进度                            | `onUpdate` partialResult                              | 只进 UI，不持久化                                                          |
| 风险/Scope/审批（Policy Bridge）    | `beforeToolCall` -> `block/terminate`                 | 撤权、越界、未批准、预算超限 -> `block:true`，错误文案走稳定码             |
| 裁剪/来源挂接/审计（Policy Bridge） | `afterToolCall` -> 替换 `content/details/isError`     | EvidenceBundle 裁剪、SourceLocator 挂接、审计追加，必要时 `terminate:true` |
| 顺序要求（发布、评分等）            | `executionMode: "sequential"`                         | 领域服务串行化                                                             |

- 默认**只注册 Wknowledge custom tools**；不注入 Pi/Coding Agent 的 Bash、Read、Write、Edit、Grep 等任何默认工具（ADR 0004 第 3 条）。
- Tool 名称继续满足 `^[a-z][a-z0-9.-]{0,99}$`（现有契约）。

## 4. Session 映射（Pi 运行态 vs 业务持久化）

| Pi 运行态                                | Wknowledge 真相源                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `AgentState.messages`（内存 transcript） | `AgentSession` + 每轮 EvidenceSnapshot；仅带入有限已完成历史理解追问，历史不是证据或权限来源            |
| `sessionId`（provider 缓存提示）         | 派生自业务 `AgentSession` 稳定 ID，不承载业务语义                                                       |
| `convertToLlm` / `transformContext`      | Adapter 实现：上下文裁剪、密文/不可信内容标记、token 预算（复用 `estimateContextTokens/shouldCompact`） |
| 进程重启后 Pi 状态丢失                   | 业务可恢复：`AgentRun` 状态机 + `AgentRunEvent` 重放；Pi Session 丢失不得损坏业务对象（M5-16 验收）     |
| 停止/继续（steering/followUp 队列）      | `AbortSignal` -> `run.stopped`；后续轮次为新 `AgentRun`，不复活已停止运行                               |

## 5. Model Gateway Bridge

- `AgentOptions.streamFn` 是唯一 Provider 出口：由 Gateway Bridge 将 Pi 的 `Model/Context` 请求转换为 Wknowledge Model Gateway 调用（组织/Provider/用户预算、数据策略、fallback、审计全部由 Gateway 决定）。
- 不注入 `getApiKey`；不注册 OpenTelemetry provider（`NOOP_TELEMETRY_CONTEXT`）。

## 6. 等价验收（S1 出口，引用不重复）

- 既有 20 条合成事件轨迹在新旧 Adapter 下逐事件等价。
- 真实合成 Tool Loop（含取消、错误、多轮）等价。
- Pi 不能获得数据库连接、宿主文件路径、环境密钥或网络直连 Provider 的能力（安全反例门禁）。
