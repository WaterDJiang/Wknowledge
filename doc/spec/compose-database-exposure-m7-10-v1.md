# M7-10-F Compose 数据库默认暴露 Spec v1

## 1. 关联

- 工作包：`M7-10` 安全测试；关联 `M7-02` 部署预检与私有化单机部署。
- 发现来源：2026-08-14 安全扫描高风险“Compose 使用已知 PostgreSQL 默认口令并将 5432 暴露到所有宿主网卡”（CWE-798/CWE-200）。
- 影响面：根 Compose、可选本地开发 override、样例配置、安装说明与 Compose 回归。

## 2. 目标

- 基础 Compose 必须要求显式 PostgreSQL 口令，不得以已知默认值启动。
- 基础 Compose 不发布 PostgreSQL 宿主机端口；Web、Worker、migrate 和运维任务继续通过 Compose 内部服务名连接。
- 本地开发若需要宿主机 `pnpm db:*`，必须显式叠加开发 override，且仅绑定 loopback。

## 3. 规则

- 所有基础 Compose 的数据库口令和内部 `DATABASE_URL` 使用同一必填 `POSTGRES_PASSWORD` 插值；变量缺失时 `docker compose config` 与启动均应失败。
- 根 `docker-compose.yml` 不得出现 PostgreSQL `ports` 映射、`5432:5432` 或 `:-wknowledge` 型默认口令。
- `docker-compose.dev.yml` 是唯一可选宿主机访问入口，仅使用 `127.0.0.1:${WKNOWLEDGE_POSTGRES_HOST_PORT:-5432}:5432`；不得用于生产部署。
- `.env.example` 不包含可用数据库 URL 或口令。README 提供创建本机 `.env` 的步骤，不将生成值提交到仓库。
- 生产仍需运行 preflight，且必须使用 Secret/KMS 注入的非默认口令；本切片不实现 Docker Secret、TLS、独立数据库实例或网络策略编排。

## 4. 验收标准

- 基础 Compose 缺少 `POSTGRES_PASSWORD` 时 fail-closed；提供临时安全值时 `docker compose config --quiet` 通过。
- 根 Compose 不向宿主机发布 PostgreSQL；开发 override 仅 loopback 映射。
- Web/Worker/migrate/backup/preflight 的数据库 URL 均继续引用同一必填变量。
- 回归先能发现默认口令和公开端口，再随配置修复通过；完整质量门禁通过。

## 5. 非范围

- PostgreSQL TLS/mTLS、Docker Secret 文件挂载、数据库帐号分离、Kubernetes NetworkPolicy、生产数据库高可用或真实公网渗透测试。
