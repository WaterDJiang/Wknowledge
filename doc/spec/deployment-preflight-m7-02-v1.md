# M7-02 部署前检查与凭据配置 Spec v1

## 1. 关联计划

- 工作包：`M7-01 镜像与 Compose`、`M7-02 配置与密钥`、`M7-03 数据库迁移`、`M7-11 运维文档`。
- 依赖：Docker Compose、本地 BlobStore、受管模型 Provider 的 AES-256-GCM 凭据加密契约。

## 2. 目标

- 在迁移、Web 或 Worker 启动前，用只读 CLI 拒绝明显错误的生产配置：数据库连接格式、部署版本、凭据主密钥、存储目录隔离和最小可用空间。
- 将 `WKNOWLEDGE_CREDENTIAL_KEY` 传入 Web 与 Worker，使存储在数据库中的 Provider 加密凭据可由受管运行时解密；值不进入 API、日志、输出或备份清单。

## 3. 检查规则

- `DATABASE_URL` 必须是带主机与数据库名的 `postgres:` 或 `postgresql:` URL；CLI 只报告 `PREFLIGHT_DATABASE_URL_INVALID`，不得打印连接串。
- `POSTGRES_PASSWORD` 在生产 preflight 必须存在且不能是开发默认值 `wknowledge`；Compose 开发默认仍可用于本地启动，但不能通过生产 preflight。
- `WKNOWLEDGE_RELEASE_VERSION` 必须是非 `unknown` 的受限版本标识；恢复和升级记录以它关联应用版本。
- `WKNOWLEDGE_CREDENTIAL_KEY` 必须以 base64url/base64 解码为恰好 32 bytes；它是 Provider AES-256-GCM 密钥，不替代 Docker Secret、KMS 或轮换策略。
- `WKNOWLEDGE_DATA_ROOT` 与 `WKNOWLEDGE_BLOB_ROOT` 必须存在、是非符号链接目录、真实路径互不包含；预检只读，不创建、删除或修复目录。
- 两个根目录所在文件系统的可用空间都必须不低于 `WKNOWLEDGE_MIN_FREE_BYTES`；缺省为 1 GiB。阈值必须是正整数，输出不含绝对路径和实际目录名。

## 4. 接口、输出与 Compose

- 根命令：`pnpm deploy:preflight`；容器服务：`docker compose --profile operations run --rm preflight`。
- 成功只输出 JSON：`status`、检查项名称和可用空间数值；失败只输出稳定 `PREFLIGHT_*` 错误码。CLI 不连接数据库、不读取业务数据、不校验模型 API Key，也不启动 Web/Worker。
- `preflight` 使用与 Web/Worker 相同的只读数据卷及运行时环境；Compose 通过环境引用传递密钥，生产部署必须改由 Docker Secret/KMS/部署平台注入，不能把明文写入版本库。

## 5. 验收

- 合格的临时目录、受限版本、数据库 URL、非默认密码和 32-byte 编码密钥返回成功，输出不包含任一路径、连接串、密码或密钥。
- 缺失/默认密码、错误 URL、错误密钥、目录重叠、符号链接或容量阈值不合法均稳定拒绝且不改动文件。
- Web 与 Worker Compose 环境均包含 `WKNOWLEDGE_CREDENTIAL_KEY`，不把具体值写入 Compose 展开结果以外的项目文件。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e` 与 `docker compose config --quiet` 通过。

## 6. 非范围

- 真实数据库连通性、迁移执行、Docker Secret/KMS 实现、密钥轮换、系统级磁盘告警、自动扩容和在线配置热更新。
