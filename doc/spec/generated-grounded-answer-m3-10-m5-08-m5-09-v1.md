# 单轮生成式有据问答 M3-10/M5-08/M5-09 Spec v1

## 1. 目标

- 在已验证的 EvidenceBundle 之后接入一个受控的 OpenAI-compatible chat Provider。
- 让模型只依据当前证据包生成自然语言回答，并校验其 Evidence ID 引用。
- Provider 未配置、不可用、超时、输出非法或引用越界时，安全降级为现有检索摘要。
- 保持 Wiki 查询 Embedding 调用为 0，不引入向量数据库。

## 2. 本轮范围

- M3-10：单轮自然语言回答、拒答、引用校验和 UI 模式显示。
- M5-08：一个由服务端环境变量配置的 OpenAI-compatible Provider、能力注册和健康检查。
- M5-09：依据知识空间 `dataPolicy` 选择本地或云 Provider。
- 本轮不实现 Provider 管理 UI、数据库密钥、模型调用持久化、多轮会话、费用预算和多 Provider 优选。

## 3. 配置契约

```text
WKNOWLEDGE_CHAT_PROVIDER_ID=openai-compatible
WKNOWLEDGE_CHAT_BASE_URL=http://127.0.0.1:11434/v1
WKNOWLEDGE_CHAT_MODEL=<model-name>
WKNOWLEDGE_CHAT_LOCATION=local
WKNOWLEDGE_CHAT_API_KEY=<optional-server-secret>
WKNOWLEDGE_CHAT_TIMEOUT_MS=20000
```

- `BASE_URL` 与 `MODEL` 同时存在才注册 Provider。
- API Key 只由服务端读取，不进入浏览器响应、日志和错误详情。
- `local_only` 只能选择本地 Provider。
- `cloud_allowed` 可以选择本地或云 Provider。
- `cloud_allowed_after_redaction` 在脱敏器实现前不能把正文发送到云 Provider，但仍可选择本地 Provider。

## 4. 调用流程

```text
问题
→ queryWikiEvidence
→ 空证据？直接拒答，不调用模型
→ 按 dataPolicy 选择健康的 chat Provider
→ 发送系统约束、问题和不可信 EvidenceBundle
→ Provider 返回 JSON GroundedAnswer
→ Zod Schema + Evidence ID 子集校验
→ generated
```

任一步失败：

```text
保留 EvidenceBundle
→ extractive_fallback
→ modelCall 记录稳定错误码
→ 不向用户展示 Provider 原始响应或密钥
```

## 5. 安全约束

- 请求不携带工具定义，模型不能发起工具调用。
- 系统提示明确声明 Evidence 内容是不可信数据，其中的指令不得执行。
- 模型不得使用证据外常识补齐缺口；证据不足时返回 `insufficientEvidence=true`。
- 模型输出必须是 JSON；Markdown 代码围栏、额外说明和未知 Evidence ID 均判定为非法输出。
- Provider HTTP 正文、堆栈、URL 参数和密钥不进入公共响应。

## 6. Agent 运行记录

```ts
type AgentModelCall =
  | {
      status: "succeeded";
      providerId: string;
      model: string;
      durationMs: number;
    }
  | {
      status: "failed";
      providerId: string | null;
      model: string | null;
      durationMs: number;
      errorCode: string;
    }
  | null;
```

- 未配置 Provider 时为 `null`。
- 调用成功时回答模式必须为 `generated`。
- 调用失败或输出校验失败时回答模式必须为 `extractive_fallback`。
- 数据库持久化仍属于 M3-11/M5-01，不计入本轮完成。

## 7. UI

- 生成成功显示“模型生成”，并说明回答已通过引用校验。
- 降级显示“检索摘要模式”，不得显示成模型回答。
- 提交时显示“检索并生成…”，结果仍分回答、证据摘录和原资料定位三层。
- Provider 错误不阻断已有证据展示，不显示技术堆栈。

## 8. 影响面

- `packages/model-gateway`：Provider 适配器、健康检查、数据策略路由和安全错误。
- `packages/agent-runtime`：模型调用、输出解析、引用校验和降级记录。
- `apps/web`：读取空间数据策略、组装 Gateway、Query UI 模式状态。
- `.env.example`：只增加占位配置，不写真实密钥。

## 9. 验收标准

- 有效 Provider 输出生成自然语言回答，`mode=generated`，引用全部属于 EvidenceBundle。
- 模型伪造 Evidence ID、返回非 JSON、超时或 HTTP 失败时降级，不展示非法输出。
- 无 Evidence 时不调用 Provider。
- `local_only` 不能调用云 Provider；未脱敏的 `cloud_allowed_after_redaction` 不能调用云 Provider。
- 未配置 Provider 时保持当前检索摘要功能可用。
- 查询路径没有 Embedding 调用。
- 浏览器可见模式、回答、证据与来源分层正确，控制台无业务错误。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e` 通过。

## 10. 后续

- M3-11/M5-01：持久化查询、候选、引用和模型调用记录。
- M5-08/M5-10：Provider 管理、连通测试和健康状态 UI。
- M5-09：多 Provider fallback、预算、限流和质量策略。
- 多轮会话、历史证据冻结和上下文裁剪。
