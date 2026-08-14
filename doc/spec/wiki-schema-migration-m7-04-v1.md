# M7-04 Wiki Schema 迁移 Spec v1

## 1. 关联计划

- 工作包：`M7-04 Wiki Schema 迁移`、`M7-05 备份恢复`、`M7-11 运维文档`。
- 前置：M7-02 preflight、M7-03 数据库升级检查、已校验的 M7-05 维护窗口备份。

## 2. 目标

- 为 Markdown Wiki 建立独立于 PostgreSQL 的空间级 Schema 清单、只读检查、受控迁移与原子回退边界。
- 当前页面 Frontmatter 保持 `schemaVersion: 1`；本切片只把历史“无空间清单的 v1 Wiki”显式迁移为“有 `schema-manifest.json` 的 v1 Wiki”，不伪造不必要的 v2 业务字段。

## 3. 兼容策略

| 状态         | 读取行为                                      | 写入行为                            | 升级结论              |
| ------------ | --------------------------------------------- | ----------------------------------- | --------------------- |
| `legacy-v1`  | 双读：无清单时按现有 Page Frontmatter v1 校验 | 只读检查不写入                      | `pending_manifest`    |
| `current-v1` | 读取空间清单和每页 Frontmatter v1             | 编译、审核、冲突发布均保留/写入清单 | `current`             |
| 未知或损坏   | 拒绝读取、迁移和发布                          | 不写入                              | `WIKI_SCHEMA_INVALID` |

- 空间清单只声明 `manifestSchemaVersion`、`wikiSchemaVersion`、升级时间和生成方式；不记录正文、宿主绝对路径、资料名、来源 URI、模型输入或密钥。
- 只读检查不改写文件；迁移只在显式维护窗口中执行，复制现有 `wiki/` 至 staging、写入清单、Lint 页面/来源/索引后通过既有原子发布替换。
- 迁移失败时保留已发布 Wiki；发布后出现应用级回退时，只能通过已校验备份或保留的原子 backup 恢复，不得手改页面 Schema 或 sourceRefs。
- 下一次真正的 v2 迁移必须先实现 v1/v2 双读、添加可逆或备份恢复路径、更新本 Spec 和设计，才可启用 v2 写入。

## 4. 接口

- 包命令：`pnpm --filter @wknowledge/wiki wiki:schema:check` 与 `wiki:schema:migrate`。
- 根命令：`pnpm wiki:schema:check` 与 `pnpm wiki:schema:migrate`。
- 检查输入为受管数据根与可选空间 ID；输出仅含稳定状态、空间数量和公开版本号。
- 迁移必须要求 `WKNOWLEDGE_WIKI_MIGRATION_QUIESCED=true`，并拒绝非 UUID 空间目录、未知参数、未知 Schema、Lint 错误和并发发布未协调的调用。

## 5. 影响面

- `packages/wiki`：Schema 状态读取、检查/迁移计划、空间 staging、清单校验和 CLI。
- `apps/worker`：后续仅在初始化/发布时确保 v1 清单存在；本切片不将批量迁移放入普通 Worker 队列。
- `deploy/operations.md`、README、根 scripts、M7 状态与 Log：维护窗口顺序和恢复边界。

## 6. 验收

- 缺少清单、但所有页面均为合法 Frontmatter v1 的 Wiki 显示 `pending_manifest`，检查不改变目录摘要。
- 清单化迁移后页面内容、Frontmatter、`sourceRefs`、`index.md`、`log.md` 与 `publish-manifest.json` 保持可用，清单显示 `current`。
- 无效清单、未知版本、页面 schema/来源 Lint 错误、非静默窗口和非法目录都 fail closed，且不留下 staging/半发布目录。
- 迁移在发布失败时恢复原始 Wiki；历史 `raw/`、`compiled/`、`mappings/`、审查/冲突快照不被修改。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e` 与 `docker compose config --quiet` 通过。

## 7. 非范围

- Frontmatter v2、全量重编译、自动回滚发布、在线无停机 Wiki 大迁移、多机器锁协调、Git 作为事务日志、恢复演练和任何数据库 migration。
