# Agent Core Adapter 准入 Spike M5-00 Spec v1

> 本文是已验证的历史基线。2026-08-17 起，Pi 生产采用与旧内部 Loop 清理由 [Pi 核心组件升级 Spec](pi-core-component-platform-upgrade-m3-m5-m6-m7-v1.md) 和 ADR 0004 接续。

## 1. 关联计划

- 工作包：`M5-00`。
- 依赖：[Agent/学习扩展计划](../plan/agent-learning-expansion-v1.md) 第 3、5、6.A、10 节。
- 当前状态：开发中；本切片只验证可替换 Agent Core 契约与内部回退，不创建会话表、不接入第三方依赖、不开放 Skill。

## 2. 目标

在 `packages/agent-runtime` 建立一个对 Pi 等候选运行时可替换的最小 `AgentCoreAdapter` 边界，并用合成、确定性的事件轨迹验证：

- 消息开始、文本增量、工具请求/完成、最终完成、失败和取消具有稳定顺序。
- 无法使用工具或收到取消信号时，不产生后续工具执行或完成回答。
- 工具名称和摘要只能来自已由平台提供的清单；Adapter 不获得数据库、BlobStore、文件系统、Shell、Git、网络或模型密钥。
- 未来 Pi Adapter 以同一份轨迹夹具进行比较；不通过时内部 Adapter 是可用回退。

## 3. 本轮范围

```text
AgentCoreAdapter interface
→ InternalAgentCoreAdapter
→ 脚本化 Provider / 合成 Tool 轨迹
→ 20 条确定性契约测试
→ Pi/OpenCode/Claude Code 准入记录
```

- 所有夹具只含固定短文本、虚构工具和虚构路径；不读取 Markdown Wiki、用户上传资料、数据库、Provider 密钥或环境变量。
- `InternalAgentCoreAdapter` 只编排已提供的“计划事件”，不负责 LLM、权限决策、Skill 执行或持久化。
- M5-01/M5-02 的真实会话、SSE、停止 API 与 `agent_session` 迁移不属于本轮。
- M5-03 至 M5-07 的 Policy、审批、Sandbox 与 Skill 执行不属于本轮。

## 4. 契约

```ts
interface AgentCoreAdapter {
  readonly id: string;
  run(input: AgentCoreRunInput): AsyncIterable<AgentCoreEvent>;
}

type AgentCoreEvent =
  | { type: "run.started"; runId: string }
  | { type: "assistant.delta"; runId: string; text: string }
  | {
      type: "tool.requested";
      runId: string;
      toolCallId: string;
      tool: string;
      inputSummary: string;
    }
  | { type: "tool.completed"; runId: string; toolCallId: string; outputSummary: string }
  | { type: "run.completed"; runId: string }
  | { type: "run.stopped"; runId: string; reason: "cancelled" }
  | { type: "run.failed"; runId: string; code: string };
```

- `run.started` 是所有正常开始运行的第一条事件。
- `run.completed`、`run.stopped`、`run.failed` 是互斥终态；终态后禁止更多事件。
- 每个 `tool.completed` 必须对应先前同一 `toolCallId` 的 `tool.requested`；一次请求最多完成一次。
- Adapter 在收到 `AbortSignal` 后发出 `run.stopped(cancelled)` 并终止；不得继续发 assistant/tool/完成事件。
- 脚本中的非法顺序必须被拒绝为 `AGENT_CORE_TRACE_INVALID`，而不是静默修正。
- `inputSummary` 与 `outputSummary` 是显示/审计摘要；它们不应承载原文资料、模型密钥或宿主路径。真实运行的脱敏规则属于后续 M5 Policy。

## 5. 准入决定

| 候选                               | 本轮结论             | 原因                                                                                                           | 后续条件                                                                                     |
| ---------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 内部 Adapter                       | 采用                 | 无外部执行权限，仅处理显式脚本事件；20 条合成轨迹作为基线                                                      | 继续作为生产回退                                                                             |
| Pi `@earendil-works/pi-agent-core` | 待审查，未安装       | 上游说明其默认以启动进程权限运行且不内建文件/进程/网络/凭据限制；尚缺锁定版本、包摘要、依赖树与 lifecycle 审查 | 在隔离目录以 `--ignore-scripts` 完成供应链记录，并通过同一轨迹与安全反例后再引入可选 Adapter |
| OpenCode                           | 模式参考，不安装     | 参考其按需加载与 `allow/ask/deny`，但完整 Coding Agent 不进入服务端                                            | 在 M5-03 实现自有 Policy/SkillAdapter 并覆盖审批与撤权                                       |
| Claude Code                        | 公开规范参考，不安装 | 借鉴 deny 优先、审批和 Hook 生命周期；CLI/账户不是可嵌入运行时                                                 | 在 M5-02/M5-03 对照事件、审批与拒绝 UX                                                       |

## 6. 验收标准

- 20 条合成轨迹覆盖正常回答、串行工具、多个工具、空增量忽略、取消、失败、未请求完成、重复完成、终态后事件、未知事件与 runId 不匹配。
- 每条有效轨迹的终态唯一，非法轨迹均以稳定错误码拒绝。
- Adapter 不依赖模型、Wiki、数据库、BlobStore 或 `skill-runtime`。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 通过；本轮无浏览器表面，不以 E2E 替代契约验证。

## 7. 风险与后续

- 此切片不证明 Pi 可以安全接入，也不代表 M5 会话、Skill 或学习功能已完成。
- 真实 Agent 运行必须在 M5-01 起把最终消息/事件/证据持久化，并在每轮、每次工具调用前重新授权。
- 真实 Tool/Skill 仍必须由服务端 Policy 和 Worker Sandbox 执行，Adapter 不能成为绕过路径。
