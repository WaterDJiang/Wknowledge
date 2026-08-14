# SkillRun 与 Worker 执行边界 M5-06 Spec v1

## 1. 目标

- 将已获策略允许或批准的 Agent 会话 Skill 请求固化为可审计 `SkillRun`，可靠投递到 Worker 队列；Next.js 只验证输入、创建状态并入队。Sandbox 子切片完成后，才允许 Worker 消费并执行。
- `SkillRun` 固定会话、组织、调用者、Skill 版本/digest、范围 Binding、审批记录和脱敏输入摘要；运行时不得被后续 Skill 升级或范围变更替换。
- 首期建立状态机、独立 Outbox 与安全前置，不加载入口文件、不执行命令、不读取原文件、不调用模型或网络。

## 2. 范围

```text
POST /api/agent-sessions/{sessionId}/skill-runs
GET  /api/skill-runs/{runId}
```

```text
queued → running → completed | failed | stopped
```

- `approval: never` 的 allow Skill 可请求；`approval: conditional/always` 必须有未过期、版本/digest/范围和输入摘要相同的 approved 记录。
- Worker 的真实 sandbox、产物目录、网络 deny、入口加载、超时/资源限制和取消执行为后续 M5-06 子切片；本切片只验证状态、可靠投递和“无执行 handler”边界。

## 3. 核心规则

- 请求时和 Worker claim 前均重新检查会话拥有者、空间成员资格、组织 Skill 启停、Manifest digest、范围 Binding 和审批状态。
- `deny` 与失效审批不创建 SkillRun；请求正文仅存长度/摘要，不存敏感原文。
- `queued/running` 的同一会话 SkillRun 不得由其他用户读取或重写；终态不可回退。
- Run 与 `skill_run_outbox` 必须同一数据库事务创建；队列发布失败回到 pending 并可重试，终态 Run 的过期 Outbox 必须丢弃。
- Worker 只创建 `skill.run` 队列并投递 Run ID；在 Sandbox 子切片完成前不得注册消费 handler，更不得加载 Skill entrypoint。
- 上传资料中的文本永远不是 Skill 参数或权限指令。

## 4. 验收

- 未登录/非会话所有者/范围撤销/审批不匹配均返回拒绝，并且没有入队记录。
- allow 与 approved ask 的请求能创建 queued Run，绑定版本、digest 和范围快照。
- Web 控制面不导入 Skill entrypoint 或执行文件系统/模型/网络动作。
- 数据库回归覆盖状态单调、审批到期、撤权和跨用户拒绝。
- Worker 可创建 `skill.run` 与 dead-letter 队列，并从独立 Outbox 重试投递 Run ID；在 Sandbox 验收前，队列不得注册执行 handler。
