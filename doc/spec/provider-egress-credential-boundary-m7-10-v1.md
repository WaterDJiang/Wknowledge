# M7-10-C Provider 出网与凭据边界 Spec v1

## 1. 关联

- 工作包：`M7-10` 安全测试；关联 `M5-08` Provider Registry、`M5-09` 模型路由。
- 发现来源：2026-08-14 安全扫描高风险“模型 Provider URL 可导致 SSRF 和既有 API Key 外传”（CWE-918）。
- 影响面：Provider 设置、Model Gateway、Web/Worker 受管 Provider 运行时与回归测试。

## 2. 目标

- Provider endpoint 只能指向部署明确允许的目标，不能由组织管理员任意选择内网或云端地址。
- 修改 endpoint 或 location 时不得复用既有 API Key；管理员必须显式重新提供凭据。
- 模型健康检查、聊天、视觉和 ASR 请求在发起前复核 endpoint，并拒绝 HTTP 重定向。

## 3. 规则

- endpoint 不允许 URL 用户信息、query 或 fragment；路径只作为兼容 OpenAI API 的基础路径。
- `local` endpoint 只允许部署配置的本地域名列表，默认仅 loopback；`cloud` endpoint 必须 HTTPS，且只允许部署显式配置或内置 Provider 预设声明的云端域名列表。显式 `WKNOWLEDGE_CLOUD_PROVIDER_HOST_ALLOWLIST` 会收窄内置集合；未收录的 host 仍安全拒绝。
- Cloud 目标在每次调用前解析；任何 loopback、私网、链路本地、保留或多播地址均拒绝。local 目标只接受部署明确允许的本地名称。
- 发送 `/models`、`/chat/completions`、`/audio/transcriptions` 时使用 `redirect: "error"`，不跟随重定向，不向重定向目标发送 Bearer 凭据或资料。
- 新建 endpoint 并提供 API Key 仍允许，但该动作必须是管理员显式的、经 allowlist 校验的凭据绑定；URL/location 变更且未重新提交 API Key 稳定拒绝。
- 已存在但现在不符合 endpoint 策略的配置在运行时安全不可用；不得读取或泄露其密钥。

## 4. 验收标准

- 直连 metadata/loopback/private URL、URL 用户信息、query/fragment、非 HTTPS cloud URL 和未在 allowlist 的 hostname 均被拒绝。
- 原有 Provider 修改 URL 而不提供新 API Key 返回稳定错误，数据库中原 URL 和密钥保持不变。
- 合格的 allowlist endpoint 只在解析到允许地址时调用；重定向响应不被跟随。
- Web 与 Worker 使用同一策略；不泄露 URL、密钥、DNS 地址或 Provider 原始错误。
- 定向回归和根质量门禁通过。

## 5. 非范围

- 不实现通用代理、任意 host egress、自动 DNS allowlist 同步或 Provider 密钥轮换。
- 不信任外部 DNS 作为唯一边界；生产还必须以防火墙/egress proxy 限制容器网络。
- 不变更空间 `dataPolicy`、模型预算或模型选择优先级。
