# M7-03 数据库升级检查 Spec v1

## 1. 关联计划

- 工作包：`M7-03 数据库迁移`、`M7-04 Wiki Schema 迁移`、`M7-05 备份恢复`、`M7-11 运维文档`。
- 依赖：Drizzle PostgreSQL migration journal、维护窗口备份与 M7-02 preflight。

## 2. 目标

- 在任何生产数据库迁移前，按当前仓库 `meta/_journal.json` 与 SQL 文件重建预期迁移清单，并以时间戳和 SHA-256 严格核验数据库 `drizzle.__drizzle_migrations` 历史。
- 用只读 `db:upgrade:check` 产生不含数据库 URL、密码、SQL 正文或业务记录的升级计划，避免把“可以启动迁移”误判为“历史一定兼容”。

## 3. 规则

- 每条预期迁移由 journal 的 `tag`、`when` 与完整 SQL 文件 SHA-256 唯一标识；缺 journal、重复 tag/时间戳、缺 SQL 或不安全 tag 均拒绝。
- 数据库迁移记录必须是预期清单的连续前缀：应用条数、`created_at`、hash、顺序和重复性任何一项不一致均以 `UPGRADE_DATABASE_MIGRATION_DIVERGED` 拒绝。
- 新数据库没有 Drizzle 迁移表时是合法 `initial` 状态，所有本地迁移列为 pending；该检查不创建 schema、表或迁移记录。
- 成功输出仅含状态（`initial`/`pending`/`current`）、已应用数量、待迁移的公开 tag 与最新已应用 tag；不得输出 SQL、hash、连接串、主机、用户名或业务数据。
- 检查只读连接 PostgreSQL。它不执行 `db:migrate`、Wiki schema 迁移、备份、恢复或应用发布；生产 runbook 必须先通过 M7-02 preflight、创建并校验 M7-05 备份，再由人工确认执行迁移。

## 4. 接口

- 包命令：`pnpm --filter @wknowledge/database db:upgrade:check`。
- 根命令：`pnpm db:upgrade:check`。
- Compose `operations` profile 提供 `upgrade-check`，只依赖健康 PostgreSQL，不启动 Web/Worker。

## 5. 验收

- 当前仓库迁移清单可稳定生成；空历史显示 `initial`，连续前缀显示 `pending` 或 `current`。
- hash、时间戳、顺序、重复记录、未知记录或本地迁移目录不完整均 fail closed，且标准输出/错误不暴露 SQL/连接串。
- 检查过程中数据库模式和迁移表不变化；迁移检查不触碰 Blob、Wiki、raw、compiled 或学习记录。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e` 与 `docker compose config --quiet` 通过。

## 6. 非范围

- 自动应用/回滚数据库迁移、强制备份联动、Wiki schema 双读/迁移、零停机 expand/contract 编排、跨版本应用兼容性矩阵与真实生产升级演练。
