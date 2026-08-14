# 用户邀请、禁用与空间成员 M1-03/M1-05 Spec v1

## 1. 关联计划

- 工作包：`M1-03 用户管理`、`M1-05 空间成员`、`M1-08 管理 UI`。

## 2. 目标

- 组织 owner/admin 能邀请本地账号加入组织及指定知识空间。
- owner/admin 能禁用非 owner 用户；禁用立即使既有会话失效且禁止登录。
- owner/admin 能管理空间成员角色或移除成员；操作只影响指定空间，不改变原始文件、Wiki 和历史审计。

## 3. 邀请模型

- 不接入邮件服务。管理员输入邮箱、组织角色和可选空间/空间角色，系统生成一次性邀请链接，由管理员在私有渠道发送。
- 数据库存储 SHA-256 token hash，绝不存储或在列表中回显 token；创建响应仅返回一次完整接受链接。
- 链接默认 7 天有效；接受时用户设置姓名和密码。已存在的同邮箱用户无需覆盖密码，只建立允许的成员关系。
- 接受成功后 token 只能使用一次；过期、已撤销或已使用 token 返回明确但不泄露组织资料的错误。

## 4. 权限和状态

- 创建/撤销邀请、组织用户列表、禁用/启用：组织 `owner` 或 `admin`。
- 不能禁用 owner，不能禁用自己，不能通过 API 改变 owner 角色。
- 空间成员新增/改角/移除：该空间 `owner` 或 `admin`；空间 owner 不能被移除或降级。
- 组织管理员必须是组织成员；空间管理员只能作用于自己已有成员身份的空间。
- 禁用用户时撤销其所有 session；`authenticate` 仍校验 `disabled`，形成双重保护。

## 5. API

```text
GET    /api/settings/users
PATCH  /api/settings/users/{userId}              { disabled }
POST   /api/settings/invitations                 { email, organizationRole, spaceId?, spaceRole? }
GET    /api/settings/invitations
DELETE /api/settings/invitations/{invitationId}
POST   /api/invitations/accept                   { token, name, password? }

GET    /api/spaces/{spaceId}/members
PUT    /api/spaces/{spaceId}/members/{userId}    { role }
DELETE /api/spaces/{spaceId}/members/{userId}
```

## 6. 验收

- 邀请 token 只返回创建响应一次，数据库和后续列表没有明文 token。
- 接受邀请后组织和指定空间成员关系正确创建，重复接受被拒绝。
- 禁用后旧 session `/api/auth/me` 返回 401，登录同样被拒绝；owner/self 禁用返回 409。
- 跨组织用户、非管理员和跨空间管理员均返回 403/404，不能枚举无权用户。
- 空间 owner 不可移除或降级；编辑者不可管理成员。
- 用户、邀请、成员变更均写入组织审计事件。
- format、lint、typecheck、数据库集成、授权 API E2E 通过。
