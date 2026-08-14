# M7-10-M8：禁用组织成员的学习与 Agent 写入路径 Spec v1

## 1. 关联

- 工作包：`M7-10` 安全复扫；补充 `M7-10-D` 组织成员禁用隔离与 `M7-10-G` Agent 运行时撤权。
- 发现来源：2026-08-14 标准安全复扫后的代码复核。学习资料枚举、学习事件、计划确认，以及 Agent 会话创建/新增 Binding 仍可能仅以 `space_membership` 判断。
- 影响面：`packages/core/src/learning-plans.ts`、`packages/core/src/agent-sessions.ts` 与学习/Agent 领域回归测试。

## 2. 目标

- `organization_membership.disabled=true` 的用户不能在该组织读取可学习资料、确认/记录学习，或创建/新增 Agent 知识上下文。
- 保持跨组织隔离：同一用户在未禁用组织中的既有资料、学习与 Agent 路径不受影响。
- 统一返回既有无权限错误，不泄露组织成员暂停状态。

## 3. 规则

- 所有由 `space_membership` 证明学习资源权限的查询，必须同时 join `knowledge_space` 所属组织的 `organization_membership`，并要求 `disabled=false`。
- 学习计划草稿、Skill 候选物化、计划确认、学习事件和后续以 `listLearningContentOptions` 为依据的操作，禁用后必须拒绝；历史计划和事件不删除。
- `createAgentSession` 与 `addAgentSessionContextBinding` 在写入前同样要求 active organization membership；之后的运行时重核仍由 M7-10-G 保持。
- 不改变全局 `app_user.disabled`、空间成员记录、既有 Session/Binding、跨组织 session 或 API 文案。

## 4. 验收标准

- 同时保留 `space_membership` 时，禁用组织成员的 `listLearningContentOptions` 为空；创建/确认计划和记录学习事件拒绝。
- 禁用成员创建 Agent Session、新增 Binding 均返回既有 `AGENT_CONTEXT_SPACE_DENIED`；重新启用后恢复。
- 未禁用的同组织成员和另一组织成员仍可完成既有学习/Agent 流程。
- 定向回归、格式、Lint、类型检查、完整单测、构建与 E2E 通过。

## 5. 非范围

- 平台级帐号封禁、历史学习/Agent 数据清理、跨组织工作区切换、将所有学习对象都强行绑定单一组织。
