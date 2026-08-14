# M7-05 一致性备份与受控恢复 Spec v1

## 1. 关联计划

- 工作包：`M7-01 镜像与 Compose`、`M7-05 备份恢复`、`M7-11 运维文档`。
- 依赖：本地 BlobStore、受管 `data/spaces/`、PostgreSQL 和已有 Wiki 原子发布。

## 2. 目标

- 为私有化 Docker 部署提供一个可校验的离线一致性备份单元：PostgreSQL dump、不可变 Blob、空间中的 Wiki/mappings/raw/compiled 与机器可读清单。
- 恢复必须先校验来源备份，再以显式确认写入两个全新的目标目录；不得静默覆盖运行中的资料目录。

## 3. 备份边界与一致性

- 首个切片采用维护窗口：操作者先停止 `web` 与 `worker`，只保留 PostgreSQL；`create` 只有在 `WKNOWLEDGE_BACKUP_QUIESCED=true` 时运行。脚本不宣称在线热备一致性。
- 备份成功后目录为 `backupRoot/{backupId}/`，固定含 `database.dump`、`data/spaces/`、`data/blobs/` 和 `manifest.json`；写入在 `.staging` 完成后才原子发布。
- 清单为 `schemaVersion: 1`，记录备份 ID、时间、应用版本、每个受管文件的相对路径、字节数、SHA-256 和总量；不记录原始正文、宿主绝对路径、数据库 URL 或密钥。
- 仅复制常规文件和目录；来源或备份内的符号链接、路径穿越、未知额外文件、摘要/长度不符均拒绝，不跟随链接。
- 备份目录不得位于被备份的数据或 Blob 根目录之内，不能递归包含自身。

## 4. 恢复规则

- `restore` 要求 `WKNOWLEDGE_RESTORE_QUIESCED=true`、`WKNOWLEDGE_RESTORE_DATABASE=true`、`--backup-id` 与完全相同的 `--confirm`；未满足时 fail closed。
- 恢复先执行完整清单校验，目标 `WKNOWLEDGE_RESTORE_DATA_ROOT` 与 `WKNOWLEDGE_RESTORE_BLOB_ROOT` 必须显式给出、彼此独立、此前不存在；脚本只写入同级 staging，成功后原子改名为目标根目录。
- 数据库恢复使用同版本 PostgreSQL Client 的 `pg_restore --clean --if-exists --no-owner`；该动作会改写目标数据库，故不允许默认执行，也不在开发/测试门禁中执行。
- 数据库或文件恢复失败时脚本清理自己创建的 staging，不删除已有目标目录、原备份或运行中资料。恢复后的数据库迁移、Wiki schema 迁移、资源/Wiki 关联巡检与开放流量属于操作者 runbook 的后续步骤。

## 5. Compose 与运维接口

- `backup` 是 `operations` profile 服务，使用 `postgres:17` 同代 Client，源数据卷只读、备份卷可写；不与 `web`/`worker` 自动并行启动。
- 根命令提供 `pnpm backup:create`、`pnpm backup:verify`、`pnpm backup:restore`；容器内分别通过 `create`、`verify --backup-id`、`restore --backup-id --confirm` 调用。
- CLI 的成功输出只包含 backupId、文件数与字节数；失败输出只包含稳定错误码，不能打印 `DATABASE_URL`、密码、绝对路径或文件正文。

## 6. 验收

- 一个含 Blob、Wiki、mappings、raw 和 compiled 的测试快照，能生成清单且 `verify` 返回成功；任一内容改写、删除、替换为符号链接或添加未追踪文件都会失败。
- 未设置静默窗口、恢复确认、数据库恢复授权或显式新目标时，命令拒绝且不写目标。
- 备份 staging 失败不发布半成品目录；完成备份不会把 `.staging` 暴露为有效备份。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 和 `pnpm test:e2e` 通过。完整 PostgreSQL 恢复演练在受控 Docker 环境另行记录，未执行前不得标记 M7-05 已验证。

## 7. 非范围

- 在线热备、增量备份、跨地域复制、S3 备份、密钥轮换、数据库/Wiki schema 迁移编排、自动定时任务和自动覆盖现有生产卷。
