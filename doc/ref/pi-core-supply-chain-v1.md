# Pi Core 供应链档案 v1

- 锁定日期：2026-08-17（工作包 `M5-13` S0）
- 关联：[ADR 0004](../design/0004-pi-core-component-runtime.md) · [升级 Spec](../spec/pi-core-component-platform-upgrade-m3-m5-m6-m7-v1.md) · [升级计划](../plan/pi-core-component-platform-upgrade-v1.md)

## 1. 锁定的包

| 项     | 值                                                               |
| ------ | ---------------------------------------------------------------- |
| 包名   | `@earendil-works/pi-agent-core`                                  |
| 版本   | `0.84.2`（精确 pin，无 `^` 范围；写入 `packages/agent-runtime`） |
| 来源   | https://github.com/earendil-works/pi（子目录 `packages/agent`）  |
| 引擎   | `node >=22.19.0`                                                 |
| 分发源 | registry.npmmirror.com（镜像上游 npmjs.org）                     |

- `pnpm-lock.yaml` 完整性记录：`sha512-8Pn3wSCxj0cfo5I6jxQYVB/3uuQRmHhAlEclyjqpOuMEdQMIODHizRogv56FLdbU+dTiGnybeHQ2N+sV1/L2YA==`
- 同 tarball shasum：`2a3212465902f2553dc08d06a8af5926d63d21a0`
- 版本策略：上游 `0.78.0` 起全部要求 Node `>=22.19.0`；`legacy-node20` 标签停留在 `0.74.2`，不采用。升级任何 Pi 版本前必须重新生成本档案并重跑契约/轨迹门禁。

## 2. 依赖树快照

直接依赖（`@earendil-works/pi-agent-core@0.84.2`）：

| 依赖                           | 版本   | 作用                  |
| ------------------------------ | ------ | --------------------- |
| `@earendil-works/pi-ai`        | 0.84.2 | 模型抽象与流式事件    |
| `@earendil-works/pi-telemetry` | 0.84.2 | 遥测 Schema/上下文    |
| `diff`                         | 8.0.4  | 文本 diff             |
| `yaml`                         | 2.9.0  | YAML 解析             |
| `ignore`                       | 7.0.5  | glob 忽略规则         |
| `typebox`                      | 1.3.7  | Tool 参数 Schema 校验 |

引入后 `agent-runtime` 生产子树共 **94 个唯一包**（pnpm 严格隔离安装）。体积主要由 `pi-ai` 的 provider SDK 传递依赖贡献：

- `@anthropic-ai/sdk@0.91.1`、`openai@6.40.0`、`@google/genai@1.52.0`、`@aws-sdk/client-bedrock-runtime@3.1048.0`（含 `@smithy/*`、`@aws-crypto/*` 全套）
- 代理/传输：`http-proxy-agent`、`https-proxy-agent`、`agent-base`
- 其他：`protobufjs`（genai 依赖）、`zod@4.4.3`（peer）、`@opentelemetry/api`、`tslib` 等

## 3. 许可证审计

94 个包全部解析出标准宽松许可证，无 copyleft、无未知：

| 许可证       | 数量 |
| ------------ | ---- |
| Apache-2.0   | 44   |
| MIT          | 36   |
| BSD-3-Clause | 12   |
| 0BSD         | 1    |
| ISC          | 1    |

## 4. 安装期脚本审计

- `pi-agent-core`、`pi-ai`、`pi-telemetry` 的 `scripts` 仅含 `build/test/clean` 等开发脚本，**无 `preinstall/install/postinstall`**。
- pnpm 10 默认拦截了传递依赖 `@google/genai@1.52.0` 与 `protobufjs@7.6.5` 的构建脚本（"Ignored build scripts" 警告）。**决定：不执行 `pnpm approve-builds` 批准它们**；两者均为不使用的 provider SDK 附属，保持 fail-closed。若未来运行报缺省产物，先评估再单独批准并记入本档案。

## 5. 风险与控制

| 风险                                                  | 控制                                                                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pi-ai` 携带 4 家 provider 直连 SDK，扩大攻击面       | Wknowledge Model Gateway 是唯一 Provider 路由（ADR 0004 第 6 条）；`StreamFn` 由 Gateway Bridge 实现，不经 `pi-ai` provider 客户端出网；SDK 在产物中不初始化、不配置凭据 |
| `getApiKey`/`transport` 等 Agent 选项可能旁路 Gateway | `PiAgentCoreAdapter`（S1）不注入 `getApiKey`；模型、凭据、预算、fallback 全部由 Gateway 决定                                                                             |
| 遥测（`pi-telemetry`）外发                            | 默认使用 `NOOP_TELEMETRY_CONTEXT`；Adapter 不注册 OpenTelemetry provider，不向外部 endpoint 发送数据                                                                     |
| 上游版本/API 漂移                                     | 精确 pin + 本档案；升级须重跑依赖树、许可证、脚本审计、20 条轨迹与安全反例门禁（Spec 第 5 节）                                                                           |
| 分发镜像源（npmmirror）完整性                         | lockfile integrity 为 sha512，安装时强制校验；与 registry.npmjs.org 的 integrity 一致性在升级窗口核对                                                                    |

## 6. 已核对的运行时入口（供 S1 映射）

- `Agent`（`dist/agent.d.ts`）：`AgentOptions`（`streamFn`、`beforeToolCall`、`afterToolCall`、`shouldStopAfterTurn`、`convertToLlm`、`transformContext`、`sessionId`）。
- `agentLoop`/`runAgentLoop`（`dist/agent-loop.d.ts`）：`AbortSignal` 停止。
- `AgentEvent`（`dist/types.d.ts`）：`agent_start/agent_end/turn_start/turn_end/message_start/message_update/message_end/tool_execution_start/tool_execution_update/tool_execution_end`。
- `AgentTool`：`prepareArguments`、`execute(toolCallId, params, signal, onUpdate)`、`executionMode`。
- 上下文裁剪：`estimateContextTokens`、`shouldCompact`、`compact`（`harness/compaction`）。

冻结的事件/Tool/Session 映射见 [ADR 0005 映射文档](../design/0005-pi-core-mapping-frozen.md)。
