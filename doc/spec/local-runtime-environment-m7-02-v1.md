# M7-02 本地运行时环境加载 Spec v1

## 1. 关联计划

- 工作包：`M7-02 配置与密钥`、`M7-11 运维文档`。
- 触发：根 `pnpm test:e2e` 启动 Web 子进程后，公开邀请接口的持久化限流器因缺少 `DATABASE_URL` 返回 `503 REQUEST_GUARD_UNAVAILABLE`。

## 2. 目标

- 让从仓库根目录执行的 `pnpm dev`、`pnpm worker` 与 Playwright Web Server 都能读取开发者显式创建的根 `.env`，使 Web 与 Worker 使用同一份本地运行时配置。
- 不在脚本、文档日志、测试输出或前端响应中写入或显示环境变量值。

## 3. 范围与规则

- Web 与 Worker 的本地启动命令使用 Node 22 的 `--env-file-if-exists=../../.env`，仅填充进程中尚未设置的变量；启动器再把已加载的环境传递给 Next/tsx 子进程，避免 Node 的 env-file 参数落入 `NODE_OPTIONS`。Compose、CI 和部署平台显式注入的变量优先。
- `.env` 不存在时启动命令保持可运行，但所有需要配置的能力按既有 fail-closed 规则返回明确错误；不得内置数据库 URL、默认生产密码或模型密钥。
- E2E 的 Web Server 必须经过同一启动脚本，不为测试额外维护第二份数据库配置。

## 4. 验收

- 复制 `.env.example` 并启动本地 PostgreSQL 后，`pnpm dev` 的 Web、Worker 与 `pnpm test:e2e` 读取同一份根配置。
- 有效格式但不存在的邀请 token 返回 `409 INVITATION_INVALID`，不再因子进程丢失 `DATABASE_URL` 返回 503。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、带本地 PostgreSQL 的 `pnpm test`、`pnpm build`、`pnpm test:e2e` 通过。

## 5. 非范围

- 自动创建或修改 `.env`、向 Git 提交任何密钥、生产 Secret 注入、数据库连接池调优和请求限流算法变更。
