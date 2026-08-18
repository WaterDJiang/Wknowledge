# 私有化运维：维护窗口备份与恢复

本流程对应 `M7-05` 的第一切片：离线一致性快照，不是在线热备。备份包含 PostgreSQL、不可变 Blob、空间下的 `raw/`、`wiki/`、`mappings/` 与 `compiled/`；不把密钥、宿主绝对路径或原文写入清单。

## 部署前检查

生产部署先从受控 Secret/KMS 取得数据库密码和 32-byte base64url 凭据主密钥，设置真实发布版本，再执行：

```bash
docker compose --profile operations run --rm preflight
```

它只检查数据库连接格式、非默认数据库密码、发布版本、凭据主密钥、数据/Blob 目录隔离和最小可用空间；不会连接数据库、读取业务正文、打印密钥或创建文件。已知不安全的 `POSTGRES_PASSWORD=wknowledge`、空主密钥或 `unknown` 版本会被故意拒绝。

`WKNOWLEDGE_CREDENTIAL_KEY` 是 Provider 凭据 AES-256-GCM 的 32-byte key。它必须对 Web 和 Worker 使用同一值，否则已保存的模型 Provider 无法解密；生产仅通过 Docker Secret、KMS 或部署平台注入，不能提交到 `.env`、Compose 文件或备份。

## Provider 网络出口

模型 Provider 只允许部署明确声明或内置预设声明的 endpoint host。Web 与 Worker 必须使用同一组环境配置：`WKNOWLEDGE_LOCAL_PROVIDER_HOST_ALLOWLIST` 用于本地模型服务，默认仅允许 `localhost`、`127.0.0.1` 和 `::1`；`WKNOWLEDGE_CLOUD_PROVIDER_HOST_ALLOWLIST` 用于云端模型服务，未设置时使用设置页内置的 OpenAI、DeepSeek、阿里云百炼、Moonshot/Kimi、智谱 GLM host 集合。部署可以显式设置该变量缩小范围；未收录的任意 host 仍被拒绝。

cloud endpoint 必须为 HTTPS、无 URL 用户信息/query/fragment，并在每次调用前解析为公网地址；IPv4-mapped IPv6 同样按其底层 IPv4 的私网、CGNAT、链路本地和保留地址规则拒绝。重定向一律拒绝。请同时在容器网络或 egress proxy 只放行相同的 host/IP 范围，应用层 allowlist 不替代网络层出口策略。修改 Provider 地址或 local/cloud 类型时，管理员必须重新提交 API Key；系统不会复用既有凭据。

公开登录和邀请接口的应用内限速只以公开业务对象作为稳定身份，不读取客户端提交的 `X-Forwarded-For` 或 `X-Real-IP`。生产反向代理必须先剥离客户端伪造的转发头；如需按真实源 IP 限流，在反向代理/WAF 层完成，不应把未经认证的转发头交给应用作为限速身份。

## 动态 Skill Sandbox

受管动态 Skill 仅在 Linux Bubblewrap 内执行；镜像必须保留 Bubblewrap，缺失或不能启动时系统会安全拒绝执行，不会回退为宿主机进程。每个 manifest 的 `memoryMb` 会传成 Bubblewrap `--rlimit-as`（每进程地址空间上限），`timeoutSeconds` 仍由 Worker 终止整个独立进程组。

基础 Compose Worker 已设置可覆盖的 cgroup 限额：`WKNOWLEDGE_WORKER_MEMORY_LIMIT=2g`、`WKNOWLEDGE_WORKER_CPU_LIMIT=2.0`、`WKNOWLEDGE_WORKER_PIDS_LIMIT=256`；并以 `WKNOWLEDGE_WORKER_TMPFS_SIZE=1g` 为 `/tmp` 中间文件创建独立 tmpfs。前 3 项约束解析、转写与 Skill 子进程的 Worker 聚合资源，tmpfs 只约束 PDF 页图、媒体转写/关键帧和报告等临时文件，不覆盖 `/app/data` 的持久化 Blob/Wiki 卷；`--rlimit-as` 仍只代表单进程地址空间。生产应按节点容量、队列并发和媒体任务调优这 4 项值，并在隔离环境用实际动态 Skill/解析任务演练内存或临时盘耗尽、Worker 重启和队列恢复，不能以命令构造回归替代生产验收。

## 升级前检查

升级应用镜像前，先完成 preflight，再创建并校验维护窗口备份，随后检查本地 SQL 与目标数据库的 Drizzle 历史是否为连续一致前缀：

```bash
docker compose --profile operations run --rm upgrade-check
```

成功输出只包含 `initial`、`pending` 或 `current`、已应用数和公开迁移 tag。hash、时间戳或顺序漂移会返回 `UPGRADE_DATABASE_MIGRATION_DIVERGED`；此时不要运行迁移，应先从备份恢复或建立兼容迁移。该检查不会写入数据库、Wiki 或资料，也不会自动执行 `db:migrate`。

## Wiki Schema 检查与迁移

每个知识空间的 Wiki 都有独立于 PostgreSQL 的 v1 Schema 清单。历史无清单的 v1 页面是可读的 `pending_manifest`，但升级前必须在维护窗口清单化。先保持 `web`、`worker` 停止，并为每个空间执行只读检查：

```bash
docker compose --profile operations run --rm wiki-schema-check SPACE_ID
```

`current` 表示清单与页面均通过 v1 校验；`pending_manifest` 表示可安全迁移；未知、损坏清单或页面/来源 Lint 问题返回 `WIKI_SCHEMA_INVALID`。输出不包含正文、来源 URI 或宿主路径。

只有已校验备份和所有写入端停止后，才对单个 `pending_manifest` 空间执行：

```bash
docker compose --profile operations run --rm \
  -e WKNOWLEDGE_WIKI_MIGRATION_QUIESCED=true \
  wiki-schema-migrate SPACE_ID
```

迁移将现有 `wiki/` 复制到 staging、写入清单、重新执行页面/来源/索引 Lint，再原子发布。它不改写 `raw/`、`compiled/`、`mappings/`、审查或冲突快照；失败时恢复已发布 Wiki。当前仅清单化 v1，不将页面伪造为 v2。

## 创建备份

1. 先确认没有上传、解析、Wiki 发布或 Skill 正在执行，再停止写入端：

   ```bash
   docker compose stop web worker
   ```

2. PostgreSQL 保持运行，创建备份：

   ```bash
   docker compose --profile operations run --rm \
     -e WKNOWLEDGE_BACKUP_QUIESCED=true \
     -e WKNOWLEDGE_RELEASE_VERSION=0.1.0 \
     backup create
   ```

3. 命令只输出 `backupId`、文件数和字节数。使用该 ID 校验：

   ```bash
   docker compose --profile operations run --rm \
     backup verify --backup-id BACKUP_ID
   ```

备份放在独立的 `wknowledge-backups` 卷。每次升级前至少执行一次创建和校验，并将该卷复制到受控的异机存储；增量、加密和异地复制尚未在本切片实现。

## 恢复演练

不要把恢复目标指向已有生产 `data/`。在新环境或全新空卷中运行，先启动 PostgreSQL，但保持 `web`、`worker` 停止。`restore` 会清空目标数据库，因此必须同时设置四个保护条件：维护窗口、数据库恢复授权、匹配确认 ID 和两个此前不存在的目标根目录。

```bash
docker compose --profile operations run --rm \
  -e WKNOWLEDGE_RESTORE_QUIESCED=true \
  -e WKNOWLEDGE_RESTORE_DATABASE=true \
  -e WKNOWLEDGE_RESTORE_DATA_ROOT=/restore/spaces \
  -e WKNOWLEDGE_RESTORE_BLOB_ROOT=/restore/blobs \
  backup restore --backup-id BACKUP_ID --confirm BACKUP_ID
```

恢复脚本先校验 manifest，再在目标同级 staging 复制文件；只有 `pg_restore` 成功后才发布两个目标目录。它拒绝已有目标、符号链接、摘要错误和未追踪文件，失败时只清理本次创建的 staging。

恢复完成后：将恢复后的目录按部署配置挂载为 `WKNOWLEDGE_DATA_ROOT` 和 `WKNOWLEDGE_BLOB_ROOT`，运行数据库迁移与 Wiki Schema 校验，执行 Blob/Wiki 一致性巡检和受权登录验收，最后才启动 `web` 与 `worker` 开放流量。完整 Docker 恢复演练尚未完成前，M7-05 不能标记为已验证。
