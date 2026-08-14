# M7-10-H Provider IPv4-mapped IPv6 地址拒绝 Spec v1

## 1. 关联

- 工作包：`M7-10` 安全复扫；关联 `M7-10-C` Provider 出网与凭据边界。
- 发现来源：2026-08-14 修复后复扫。cloud Provider 的允许域名经 DNS 解析后，`::ffff:172.16.x.x`、`::ffff:100.64.x.x`、`::ffff:198.18.x.x` 等 IPv4-mapped IPv6 非公网地址可能绕过现有 IPv4 私网拒绝。
- 影响面：`assertProviderEndpoint` 的 DNS 地址分类与 Provider healthcheck/调用前重核。

## 2. 目标

- cloud Provider 的每个 DNS 结果必须是全局可路由地址；IPv4-mapped IPv6 的底层 IPv4 适用同一套非公网地址拒绝规则。
- 本切片只修正地址分类，不更改 allowlist、HTTPS、禁止重定向、凭据重绑或 Provider API 契约。

## 3. 规则

- `::ffff:<IPv4>` 必须抽取映射 IPv4，并复用 IPv4 的 loopback、RFC1918、CGNAT、链路本地、基准测试网络、组播/保留地址拒绝规则。
- 任一 DNS 结果不满足时，稳定拒绝为 `MODEL_PROVIDER_ENDPOINT_DENIED`，并且不启动 HTTP 请求。
- 已允许 HTTPS host 且全部 DNS 结果是合法全球地址的行为保持不变。

## 4. 验收标准

- 回归覆盖 `::ffff:172.16.0.1`、`::ffff:100.64.0.1`、`::ffff:198.18.0.1` 均在 Provider 请求前拒绝。
- 覆盖一条普通公网 IPv4 DNS 结果仍允许通过。
- 相关模型网关测试、全量质量门禁通过。

## 5. 非范围

- DNS pinning/连接层重验证、IPv6 地址库替换、网络 egress firewall、Provider allowlist 产品策略和已配置 Provider 的批量清理。
