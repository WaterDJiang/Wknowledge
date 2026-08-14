# M7-10-D 组织成员禁用隔离 Spec v1

## 1. 关联

- 工作包：`M7-10` 安全测试；关联 `M1-03/M1-05` 组织成员与邀请。
- 发现来源：2026-08-14 安全扫描高风险“组织管理员可全局禁用跨组织用户”（CWE-269）。
- 影响面：`organization_membership` Schema/迁移、组织与空间授权、成员设置 API、学习生成入口和审计。

## 2. 目标

- 组织管理员只能暂停本组织内的成员访问，不能修改全局 `app_user.disabled` 或删除该用户所有会话。
- 被暂停成员不能读取、写入或管理本组织的空间和组织资源；该成员在其他组织的会话与授权保持可用。
- 重新启用恢复原组织角色与空间成员关系，不重建历史学习、资料或会话。

## 3. 规则

- `organization_membership.disabled` 是组织级访问状态，默认 `false`；`app_user.disabled` 保留给未来平台级禁用，不可由组织管理员 API 修改。
- `requireOrganizationRole`、`getManagedOrganization`、`requireSpaceRole`、空间列表和依赖组织选择的学习生成入口均忽略 disabled membership。
- 禁用不删除 `app_session`、`organization_membership`、`space_membership`、资料、学习或审计记录；访问在每次服务端授权时立即拒绝。
- 组织 owner 与管理员自己仍不能通过此 API 禁用；跨组织目标返回不存在，不泄露成员状态。
- 管理列表展示当前组织 membership 状态；审计保留组织、操作人、目标与状态，不记录会话或其他组织信息。

## 4. 验收标准

- 同一用户加入组织 A/B 后，A 管理员禁用该用户仅使 A 的组织/空间授权拒绝；B 继续允许，`app_user.disabled` 和现有 session 均不变。
- A 管理员重新启用后，A 的原权限恢复；不用重新邀请或重新分配空间角色。
- disabled 组织管理员不能访问设置页；disabled 普通成员不出现在空间列表，且所有 `requireSpaceRole` 路径拒绝。
- owner/self/非成员保护保持生效；全量质量门禁通过。

## 5. 非范围

- 平台级用户封禁、OIDC 帐号禁用、跨组织工作区选择器与跨组织 session 分割。
- 删除组织成员、删除空间成员或自动清理该成员的历史数据。
