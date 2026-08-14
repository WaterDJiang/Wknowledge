# 受控内置 Skill 执行 M5-06/M5-07 Spec v1

## 1. 目标

- 将已入队的 `SkillRun` 由 Worker 安全认领并执行首个固定内置只读 Skill `wiki-lint`，验证完整执行状态机而不开放动态入口加载。
- Worker 执行前重新校验会话所有者、空间成员、组织启停、Manifest ID/version/digest、范围 Binding 与 Policy；不满足时以稳定错误码结束 Run。
- 执行结果只保存脱敏结构化摘要（扫描空间数、问题数），不保存 Wiki 正文、完整 Lint 明细、原始文件路径或模型/网络输出。

## 2. 范围

```text
queued → running → completed | failed
```

- 仅 `skills/builtin/wiki-lint` 可执行；它对当前 active Binding 的 `data/spaces/{spaceId}/wiki` 运行 `lintWikiDirectory`。
- `wiki-query`、`wiki-compile`、`wiki-correct`、第三方 Skill、Python Skill 和任何学习/模型 Skill 仍只可入队，不注册执行器。
- Worker 不通过 `import()`、Shell 或 Manifest `entrypoint` 执行代码；`wiki-lint` 是编译期固定调用。

## 3. 核心规则

- 只处理 `queued` Run；重复、已停止、已完成或正在运行的队列消息无副作用。
- Manifest 必须来自受管 `skills/builtin`，并与 Run 的 ID/version/digest 精确匹配；组织停用或会话范围撤权后不得执行。
- `wiki-lint` 必须保留 `network: deny`、`filesystem: read`、`approval: never`；任何权限、能力或 Policy 不匹配均拒绝。
- 数据目录路径只由 Worker 配置根目录和数据库 Binding 的 `spaceId` 组成；以真实路径再次确认仍位于受管根目录内，拒绝动态路径、`..`、符号链接入口和用户输入路径。目录不存在或不可解析时仅记录稳定错误码。
- 运行前后写审计事件。错误仅保存固定 code；Run 状态单调，完成后不允许被队列重复消息改写。
- 本切片的 Handler 无模型调用、Embedding、HTTP、子进程、原始 Blob 读取或产物写入。

## 4. 验收

- 合法、已启用的 `wiki-lint` Run 只扫描已绑定空间并完成；摘要可读取，完整正文/路径不入库。
- 停用、版本/digest 变化、撤权、错误范围、非支持 Skill 和重复消息均不执行且转为失败/保持终态。
- 自动化覆盖状态认领、授权重核、Manifest/安装漂移、目录与符号链接约束、结果摘要、失败终态与不调用网络/模型。
- Worker 注册 `skill.run` 消费器后，其他 Skill 不因队列存在而执行。

## 5. 后置

- Linux 容器级 uid/cgroup/网络 namespace、外部网络 allowlist、进程型 TS/Python Skill、受控 input/artifact 目录、取消传播和跨进程事件流。
- `practice-generate`、`assessment-generate`、`plan-compose` 等模型 Skill；它们须在本切片和模型数据策略/预算验收后接入。
