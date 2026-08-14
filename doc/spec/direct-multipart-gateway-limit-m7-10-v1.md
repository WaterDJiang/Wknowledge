# M7-10-M2 直传 multipart 网关限额 Spec v1

## 1. 关联

- 工作包：`M7-10` 安全复扫；关联 `M2-01` 上传协议、`M2-11` 存储失败与 `M7-10-M1` 分片上传流式限额。
- 发现来源：M7-10 上传体审阅。小文件创建和资料替换路由必须通过 `request.formData()` 获得 multipart 字段；`File.size` 校验发生在解析后，不能单独约束 HTTP 入口的内存或临时磁盘占用。
- 影响面：生产 Docker Compose 对外 HTTP 入口；不改变小文件 8 MiB 业务限制、分片上传协议或 Route Handler 的权限/文件准入规则。

## 2. 目标

- 生产 Compose 仅由反向代理公开 `3000`；Next Web 服务不再直接发布宿主机端口。
- 反向代理在 multipart 进入 Next 进程前拒绝超过 9 MiB 的请求体。
- 9 MiB 必须覆盖 8 MiB 文件与有限 multipart 边界开销，而不能放开为任意大 body。

## 3. 规则

- 增加受版本控制的 Nginx gateway，`client_max_body_size 9m`、受限 body timeout，并只代理给内部 `web:3000`。
- `web` 服务仅暴露给 Compose 内部网络；外部只访问 `gateway:3000`。
- 小文件及替换 Route Handler 保留 `DIRECT_UPLOAD_MAX_BYTES` 和文件签名/类型/权限校验。网关是第一道 HTTP 体边界，应用层仍是业务正确性边界。
- 直接运行 `pnpm dev` 不等同生产入口；开发者需通过分片/文件大小校验测试，生产验收必须经 Compose gateway。

## 4. 验收标准

- `docker-compose.yml` 的 `web` 不含宿主机 `ports`，`gateway` 独占 `3000:3000`。
- gateway 配置包含 `client_max_body_size 9m`，代理目标仅为 Compose DNS `web:3000`，且不把应用服务的数据库或数据卷暴露给 gateway。
- 静态配置回归、`docker compose config --quiet`、全量质量门禁通过。
- 运行时容器验证在镜像可用的环境中确认：8 MiB 合法 multipart 可到达业务校验，超过 9 MiB 由 gateway 返回 413，Next handler 不被调用。

## 5. 非范围

- 让 Next Route Handler 自行流式解析 multipart；若未来脱离 gateway 部署，需要独立的 multipart streaming parser 与同等入口限制。
- 任意部署平台的 WAF/CDN 配置、上传总量配额、BlobStore 流式写入、真实大文件浏览器验收。
