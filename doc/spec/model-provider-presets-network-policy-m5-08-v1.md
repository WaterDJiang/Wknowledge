# Provider 预设与云端网络策略兼容 M5-08 Spec v1

## 1. 目标

- 修复线上配置 OpenAI-compatible 云端模型时因空 cloud host allowlist 导致的阻断。
- 在系统设置中提供受管服务商、匹配接口地址和常用模型选择；管理员只需补 API Key 即可保存配置。
- 保留 SSRF 防护：所有云端地址仍须 HTTPS、受控 host、DNS 解析为公网地址，并拒绝重定向。

## 2. 范围

- 增加共享 Provider 预设目录：服务商显示名、固定兼容地址、模型选项、能力和部署位置。
- 增加设置 API 返回预设目录与当前策略可用性；自定义 OpenAI-compatible Provider 继续保留。
- 设置页改为“服务商 → 地址 → 模型”联动；选择预设后自动填充地址和模型，API Key 仍由管理员输入。
- 保存后自动执行一次受管连通测试；健康配置直接进入模型路由，失败只保留配置并给出可操作提示。
- 云端 allowlist 未显式配置时，仅允许预设目录中的固定云端 host；显式配置时以部署 allowlist 为准，支持缩小范围。
- 未纳入预设的任意 host 仍不得通过设置页或运行时调用。

## 3. 非范围

- 不在浏览器或数据库保存 API Key 明文。
- 不放宽 HTTP、内网、私网、链路本地、DNS rebinding 或重定向防护。
- 不自动探测 Provider API Key，也不把 `/models` 返回的任意模型写入系统配置。
- 不改变本地 App SQLite 组合根；本切片只影响线上 Web/Worker 的 PostgreSQL Provider Registry。

## 4. 预设首批目录

首批提供 OpenAI、DeepSeek、阿里云百炼、Moonshot/Kimi、智谱 GLM 五个云端 OpenAI-compatible 入口，并提供 Ollama 本地入口和“自定义 OpenAI-compatible”选项。每个预设至少包含一个稳定模型，目录允许后续追加模型但不能覆盖既有 ID 的地址语义。

## 5. 安全契约

- `providerEndpointPolicyFromEnvironment()` 的默认 cloud host 集合来自预设目录。
- `WKNOWLEDGE_CLOUD_PROVIDER_HOST_ALLOWLIST` 一旦设置，完全替代默认集合；它是部署侧收窄策略，不是前端可修改配置。
- 设置 API 保存前仍执行 `assertProviderEndpoint()`；运行时每次调用仍执行同一校验和公网 DNS 解析。
- 预设目录只返回固定地址和公开模型元数据，不返回环境变量、凭据或 DNS 地址。

## 6. 验收标准

- 未设置 cloud allowlist 时，DeepSeek 预设地址 `https://api.deepseek.com` 可通过静态策略校验；未收录 host 仍被拒绝。
- 设置页选择 DeepSeek 后自动填充地址和 `deepseek-v4-flash`，选择模型后只需输入 API Key 即可提交。
- 显式设置 allowlist 后，目录中未列入该 allowlist 的预设显示为不可用并在提交前给出可操作提示。
- 自定义地址仍走原有 Zod、HTTPS、allowlist、DNS 公网和密钥重绑规则。
- API Key 仍只返回 `hasApiKey`；创建、编辑、测试失败不泄露 Provider 原文响应。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 与设置页 E2E 通过。

## 7. 影响面

- `packages/contracts`：Provider 预设契约与公开目录。
- `packages/model-gateway`：默认 cloud allowlist 来源与策略测试。
- `apps/web`：预设 API、设置页联动和错误提示。
- `docker-compose.yml`、`.env.example`、`deploy/operations.md`：部署策略说明与可收窄配置。
- `doc/plan/delivery-status-v1.md`、`doc/log/{YYYY-MM-DD}.md`：M5-08 状态和证据记录。
