# M1-02/M1-09 公开邮箱验证注册与试用空间 Spec v1

## 1. 目标

- 允许任意邮箱以一次性验证码完成注册；不按邮箱地址或域名设置注册白名单。
- 新注册用户获得隔离的个人试用组织和初始知识空间，可立即使用既有资料、Wiki 和学习功能。
- 邮件发送使用 Resend 或 SMTP；生产环境未配置发信服务时明确拒绝发送，不创建半成品账号。

## 2. 范围

- `M1-02`：新增发送验证码、验证并注册的 API、登录页注册入口和注册表单。
- `M1-02`：验证码采用随机六位数字、哈希保存、十分钟有效、单次使用；验证成功后用户设置姓名和密码，并写入 HttpOnly 会话。
- `M1-02`：验证码页与邮箱页使用独立受控表单状态；切换到验证码页时，验证码、显示名称和密码输入不得复用或带入邮箱值。深色小屏表单须保持文字、边框和输入底色可读。
- `M1-02`：注册或密码登录成功后直接替换到 `/workspace/resources`，避免经过工作台根路由的额外跳转使新 HttpOnly 会话初始化不稳定。
- `M1-03/M1-04`：新用户事务性创建个人组织、owner membership 和一个私有知识空间；不加入任何既有组织或空间。
- `M1-09`：发送验证码、验证和注册均复用持久化公开 mutation 限流；不把验证码、SMTP 密码或 Resend Key 写入日志、响应或数据库审计元数据。
- 运行时配置采用 `WKNOWLEDGE_` 前缀，并由 Compose 显式传入 Web；Worker 不持有发信密钥。

## 3. 非范围

- 不增加试用到期、付费、套餐、邮箱白名单或管理员审批。
- 不替换既有邮箱密码登录、邀请链接或 bootstrap owner。
- 不实现 Google OAuth、邮件找回密码、验证码登录既有账号或批量发信。

## 4. 环境变量

- `WKNOWLEDGE_ALLOW_SIGNUP=false`：默认关闭；设为 `true` 时公开注册。
- Resend：`WKNOWLEDGE_RESEND_API_KEY`、`WKNOWLEDGE_EMAIL_FROM`。
- SMTP：`WKNOWLEDGE_SMTP_HOST`、`WKNOWLEDGE_SMTP_PORT`、`WKNOWLEDGE_SMTP_USERNAME`、`WKNOWLEDGE_SMTP_PASSWORD`、`WKNOWLEDGE_SMTP_TLS_INSECURE=false`、`WKNOWLEDGE_EMAIL_FROM`。端口 `465` 使用隐式 TLS，其他端口必须支持 STARTTLS。
- SMTP 与 Resend 同时配置时，SMTP 优先；生产 SMTP 缺少用户名或密码时拒绝发送。

## 5. 验收标准

- `WKNOWLEDGE_ALLOW_SIGNUP=true` 且已配置发信服务时，任意新邮箱可收到验证码、完成注册并进入自己的空白工作台。
- 新用户不得读取、加入或管理 bootstrap owner 的组织、空间、资料、Wiki、会话或模型设置。
- `WKNOWLEDGE_ALLOW_SIGNUP=false` 时，注册 API 返回稳定错误，现有登录和邀请接受不受影响。
- 过期、错误、已使用验证码和重复邮箱均不会创建组织、空间、用户或会话半成品。
- 填写邮箱并成功发送验证码后，验证码输入为空且只接受六位数字；显示名称与密码输入可见、可聚焦且不含邮箱值。390px 深色表单的正文、标签、边框与输入文字对比度不低于 4.5:1。
- 已成功注册的用户使用邮箱和密码登录后，浏览器进入 `/workspace/resources`，工作台不再立即回到登录页。
- Resend、SMTP 成功/失败、限流、公开注册关闭、组织隔离和 Compose 环境映射均有自动化覆盖。
