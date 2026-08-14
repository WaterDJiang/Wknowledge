# Agent 模型 Tool Loop M5-02/M5-10 Spec v1

## 1. 关联计划

- 工作包：`M5-02`、`M5-10`，依赖已验证的 `M5-01/M5-11/M5-12` 会话、运行审计、事件重放与范围 Binding。
- 上游：[Agent 对话与学习体验](agent-conversation-learning-experience-v1.md)、[Agent 会话范围](agent-session-space-context-m5-01-m5-12-v1.md)。
- 当前状态：开发中。本切片只接入受管 `knowledge.search/read` 模型 ToolCall；不加载任意 Skill、不开放 Shell/网络/真实路径，也不改变模型 Provider 管理策略。

## 2. 目标

- 让支持 OpenAI-compatible `tool_calls` 的 chat Provider 以“请求工具 → 服务端执行 → 读取受控结果 → 生成回答”的方式完成知识问答。
- 保留无 ToolCall Provider 的既有确定性检索 + 有据生成/摘要降级，避免模型能力差异阻断知识问答。
- ToolCall 由服务端逐次验证、执行和记录；模型消息、工具参数和上传资料不能扩大 Binding、读取未检索正文或调用其他能力。

## 3. 允许的工具协议

| 工具               | 模型可见参数                                 | 服务端实际行为                                                              | 禁止事项                                     |
| ------------------ | -------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------- |
| `knowledge.search` | 无。查询固定为当前用户消息                   | 在当前 active Binding 的空间/页面/版本/Course filter 内 Markdown-first 检索 | 手工路径、改写 Binding、全库或原始 Blob 遍历 |
| `knowledge.read`   | `evidenceIds`，只能引用同轮 search 返回的 ID | 读取已过滤 EvidenceBundle 中相应片段                                        | 新页面、未检索正文、资源 URI、跨空间 ID      |

- 每轮最多执行一次 search 与一次 read，且顺序必须为 `search → read → final`。
- ToolCall ID、工具名、参数结构、数量、顺序和 evidence ID 都在运行时校验；异常请求不执行，转为模型失败/确定性降级。
- 最终回答继续受 `groundedAnswerSchema` 和 EvidenceBundle 引用校验；没有证据不调用模型生成答案。

## 4. 模型与事件边界

- Model Gateway 仅解析 chat Provider 的结构化 `tool_calls` 和文本 content；请求有工具时转发受控定义，不改变 Provider 的数据策略、超时、密钥或取消语义。
- ToolCall 事件显示“请求/完成”及脱敏摘要，不保存问题、证据正文、工具返回正文、路径或 Blob URI。
- 一轮多个模型 HTTP 调用聚合为同一个 `AgentRun`；最终记录的模型标识和耗时来自该轮受控调用，领域审计仍以 ToolCall 与 EvidenceBundle 为准。

## 5. 验收

- 脚本化 Tool-capable Provider 依次请求 search、read 并输出合法 JSON 回答时，运行记录、SSE、ToolCall 审计和来源全部保持正确。
- `knowledge.read` 传入未检索、跨范围或重复 evidence ID 时，只读取当前 EvidenceBundle 的有效去重子集；空选择不读取正文。
- 非法工具、错误顺序、重复请求或超过两步的 ToolCall 不执行；无 ToolCall Provider 继续走原有有据生成/摘要降级。
- 被取消的运行不会在工具或模型调用后保存助手回答；`embeddingCalls` 始终为 0。
