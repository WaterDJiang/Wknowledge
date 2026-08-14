# M7-10-G Agent 组织成员暂停撤权 Spec v1

## 1. 关联

- 工作包：`M7-10` 安全复扫；关联 `M7-10-A` Agent 历史撤权和 `M7-10-D` membership 级暂停。
- 发现来源：2026-08-14 安全复扫高风险。HTTP 空间入口已检查 `organization_membership.disabled`，但 Agent/Skill Worker 运行时仍只检查 `space_membership`。
- 影响面：Agent 会话 Binding 解析、历史读取校验、动态 Skill 运行前重核和回归测试。

## 2. 目标

- 组织成员一旦被暂停，其当前组织下的既有 Agent Binding 立即视为不可读、不可执行。
- Worker 不得因历史 `space_membership` 尚存在而继续执行排队或已领取的 SkillRun。
- 其他组织成员关系保持独立；本切片不删除历史会话、资料、审计或其他组织权限。

## 3. 规则

- `assertSessionBindingsReadable` 与 `resolveAgentSessionContext` 必须同时证明 `space_membership` 和所属 `organization_membership.disabled=false`。
- 不满足任一成员条件的 active Binding 必须被标记 `revoked`；后续 SkillRun 因 Binding 缺失返回既有稳定 `SKILL_SCOPE_REVOKED`，不启动 Sandbox。
- 历史详情或事件读取遇到被暂停组织的 Binding 返回 `AGENT_SESSION_ACCESS_REVOKED`，不返回回答、来源、ToolCall 或事件。
- 禁用操作不跨组织清理会话；其他组织的 Agent Session 仍可读取和执行。

## 4. 验收标准

- 组织成员暂停后，空间成员记录仍存在时 `resolveAgentSessionContext` 也撤销 Binding。
- 既有 Agent 详情与事件拒绝；排队动态 Skill 在 Sandbox executor 调用前失败。
- 重新启用后，未被删除的 Binding 可按既有授权规则恢复；全量质量门禁通过。

## 5. 非范围

- 禁用时批量更新历史 SkillRun、跨组织工作区选择器、平台级帐户禁用或主动删除 Agent 历史。
