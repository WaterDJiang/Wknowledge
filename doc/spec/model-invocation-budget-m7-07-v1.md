# M7-07 模型调用限流与预算 Spec v1

## 1. 关联计划

- 工作包：`M7-07 限流与预算`，接续 `M1-09` 请求防护、`M5-08/M5-09` 模型路由与 `M7-06` 运营快照。
- 当前切片：为所有受管模型实际调用增加组织、Provider 与可识别用户的滚动 24 小时调用预算；不把请求频率误当作模型预算。

## 2. 目标

- 在模型 Provider 收到请求前，以 PostgreSQL 原子检查拒绝超过预算的调用。
- 同一组织、同一 Provider 和发起用户共享稳定的滚动日窗口；Worker 无用户上下文时仍执行组织与 Provider 两层预算。
- 预算拒绝不调用 Provider、不记录输入、正文、密钥、URI 或宿主路径，并向 Web/Worker 返回稳定错误码。
- 继续复用 `request_rate_limit` 的哈希键表，不新增一份未迁移的计数真相源。

## 3. 范围与配置

- 默认滚动窗口为 86,400 秒；默认上限为组织 600 次、Provider 300 次、用户 60 次。环境变量可分别覆盖：
  - `WKNOWLEDGE_MODEL_ORGANIZATION_DAILY_LIMIT`
  - `WKNOWLEDGE_MODEL_PROVIDER_DAILY_LIMIT`
  - `WKNOWLEDGE_MODEL_USER_DAILY_LIMIT`
- 仅接受 1 至 1,000,000 的整数；缺失、空值或非法值回退默认值，避免因环境拼写错误关闭整个模型入口。
- 预算单位是“即将实际向 Provider 发出的调用次数”，不是 token、字符数、费用估算或健康检查次数。供应商实际 token/费用标准化留待 Provider 用量契约完善后再计量。

## 4. 规则

- `ModelGateway` 先完成能力、数据策略和健康筛选，再执行预算 Guard，最后调用 Provider。
- Guard 的多个计数键必须在同一数据库事务内消费：任意一个超限时全部回滚，不消耗其余预算；仅 Provider 层超限时可尝试下一健康且策略相容的 Provider。
- 键仅由固定 scope 与组织/Provider/用户 ID 组成，底层持久化前 SHA-256 哈希；返回或审计中不得出现原 subject。
- Web 的单轮问答与多轮会话传入 user ID；学习 Worker 传入 SkillRun 用户；ASR/Vision Worker 在无可靠发起用户时仅传组织 ID。
- `MODEL_BUDGET_EXCEEDED` / `MODEL_PROVIDER_BUDGET_EXCEEDED` 是可预期拒绝：后者仅允许 Gateway 尝试下一个健康 Provider；全局或用户超限时 Web 返回 429 与可操作提示，会话 SSE 返回稳定码，学习 Worker 记录 `LEARNING_GENERATION_BUDGET_EXCEEDED`。被拒绝的 Provider 不能被调用。
- 既有同源/IP/用户请求频率限制继续保留，二者互补且不能互相替代。

## 5. 影响面

- `packages/database`：通用多键限流的原子消费接口与数据库回归。
- `packages/core`：预算配置解析、模型调用 Guard 与稳定错误处理。
- `packages/model-gateway`：Provider 选定后的 Guard Hook。
- `apps/web`：单轮问答、会话与可读的 429 降级。
- `apps/worker`：学习、ASR、Vision 受管 Gateway 的组织/Provider 预算。
- `doc/`：设置/运维页面后续展示有效额度和用量时，仍只呈现聚合计数。

## 6. 验收标准

- Guard 拒绝时 Provider `invoke` 为零次，且能力/策略不相容 Provider 不触发预算消费。
- 一次组织/Provider/用户联合预算中任一层超限时，其余键不被部分消费。
- 单轮 API 返回 429 `MODEL_BUDGET_EXCEEDED`；多轮 SSE 与学习 Worker 保留稳定且不含敏感数据的失败码。
- 无用户的媒体 Worker 仍受组织与 Provider 预算限制。
- 所有 M7-07 配置解析、拒绝与事务回滚路径有自动化回归；最后执行根质量门禁。

## 7. 非范围

- 每 Provider 的 token、金额、余额、供应商账单同步或自动购买额度。
- 管理员在线修改预算、按部门/项目分摊、外部告警、外部网关限流。
- 信任来自客户端的 Provider、组织、用户或预算字段。
