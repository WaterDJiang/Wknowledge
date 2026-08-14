# M7-10-M10：Provider DNS 重绑定固定传输 Spec v1

## 1. 关联

- 工作包：`M7-10` 安全复扫；补充 `M7-10-C/H` Provider endpoint allowlist 与非公网地址拒绝。
- 发现来源：2026-08-14 标准安全复扫中风险项。`assertProviderEndpoint` 校验云端 DNS 结果后，默认 Web Fetch 仍会独立进行实际连接解析。
- 影响面：`packages/model-gateway/src/index.ts`、Provider endpoint policy 与模型网关回归。

## 2. 目标

- 云端 Provider 每个实际 HTTP 请求只连接到同次受控 DNS 解析已验证为公网的地址，不让默认 Fetch 在校验后再次自行解析。
- 保持本地 Provider 的测试 Fetch 注入、HTTPS allowlist、无重定向、超时/取消和 OpenAI-compatible 协议行为；cloud Provider 不接受普通 Fetch 作为传输替代。

## 3. 规则

- 云端 endpoint 在请求前执行 allowlist、HTTPS 与 DNS 公网校验；固定传输把该解析结果作为 Node HTTP(S) `lookup` 唯一返回值。
- 固定传输不得跟随重定向；请求 Host/SNI 仍为 allowlisted 域名，TLS 证书不因 IP 固定而失效。
- JSON 与 FormData 通过受控 Request 序列化后发送；响应作为 Web `Response` 返回，以维持调用方解析路径。
- 传输层错误仍由既有 Provider 统一映射为 `MODEL_PROVIDER_UNAVAILABLE`；不记录密钥、完整输入或 DNS 地址。
- cloud Provider 无条件使用固定 lookup；显式传入的测试 Fetch 仅可用于 local Provider 的仓库测试 seam，不作为生产配置接口。

## 4. 验收标准

- 受控 lookup 可让一个不存在于系统 DNS 的测试主机连接至指定本地测试服务，证明实际 socket 使用固定地址而非系统 DNS。
- 云端 allowlist 解析为非公网地址时仍在网络请求前拒绝；合法公网结果可形成固定 lookup。
- 本地兼容 Provider 的测试 Fetch、聊天、视觉与 ASR 契约保持通过。
- 即使 cloud Provider 构造时提供普通 Fetch，调用也必须使用固定传输且普通 Fetch 不得被调用。
- 格式、Lint、类型检查、完整单测、构建和 E2E 通过。

## 5. 非范围

- Proxy 支持、HTTP/2 连接复用、DNS 缓存、远程 S3、Provider 响应大小限制和外部网关级 egress firewall。
