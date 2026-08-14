# M1-09 安全基线：CSRF、Cookie、限流与错误脱敏

## 目标

为当前本地账号、空间管理、资料处理和 Wiki 审核接口建立可验证的请求安全边界，避免登录 Cookie 被跨站写请求滥用，并限制高风险接口的暴力尝试与误操作洪峰。

关联工作包：`M1-09`。

## 范围

- 保持会话 Cookie 为 `HttpOnly`、`SameSite=Lax`、生产环境 `Secure`、路径 `/`。
- 已登录用户的 `POST`、`PATCH`、`PUT`、`DELETE` 必须验证 `Origin` 与当前请求源一致，再执行状态写入。
- 登录和邀请接受也验证同源请求，拒绝跨站提交。
- 用 PostgreSQL 保存哈希化的限流键；不保存原始 IP、邮箱、令牌、请求正文或 Cookie。
- 登录、邀请接受、上传、任务控制、管理设置、空间管理、Wiki 审核/冲突和知识问答写审计路径接入限流。
- 返回固定的 `CSRF_ORIGIN_DENIED`、`CSRF_ORIGIN_REQUIRED`、`RATE_LIMITED` 错误码和可重试时间；不回显内部异常。

## 非范围

- 反向代理信任链、WAF、全局分布式限流、账户锁定、验证码和预算限额，归入 M7 生产加固。
- Token/API-key 认证、OIDC、CORS 开放策略。
- 代替既有 RBAC、上传 MIME 校验或模型/Skill 数据策略。

## 设计约束

- 限流键以 `scope + subject` 做 SHA-256，`subject` 是用户 ID、规范化邮箱或请求声明的客户端地址；它只用于节流，不作为身份或权限事实。
- PostgreSQL `INSERT ... ON CONFLICT ... RETURNING` 完成计数更新，避免多 Web 进程出现内存计数不一致。
- 已登录写请求先通过身份与 RBAC，再进入同源和限流检查；未登录请求保持既有 `401`，避免改变权限错误语义。
- 公共登录/邀请接口在解析最小输入后先做同源和限流检查，邀请令牌仍是一次性能力凭证，不写入限流表。
- 前端所有同源 `fetch` 不需要额外 header；浏览器会发送 `Origin`。非浏览器集成方应经未来专用 API 认证，不直接复用 Cookie 写接口。

## 验收标准

- 带已登录 Cookie 的跨源写请求返回 `403 CSRF_ORIGIN_DENIED`，不产生业务写入。
- 缺少 `Origin` 的 Cookie 写请求返回 `403 CSRF_ORIGIN_REQUIRED`。
- 同源写请求继续走既有 RBAC 和业务状态机。
- 同一限流键超过阈值返回 `429 RATE_LIMITED`，包含正整数 `retryAfterSeconds`，窗口结束后恢复。
- 限流表与 API 响应不包含邮箱、令牌、Cookie 或请求正文。
- 登录 Cookie 属性与现有浏览器登录流程保持兼容。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e` 通过。
