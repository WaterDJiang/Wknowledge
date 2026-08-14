# M7-01/M7-02/M7-11 GitHub Actions 阿里云部署 Spec v1

## 1. 关联计划

- 工作包：`M7-01 镜像与 Compose`、`M7-02 配置与密钥`、`M7-11 运维文档`。
- 目标环境：阿里云轻量应用服务器 `BT-Panel-ojuu`；应用仅绑定本机回环端口，由既有宝塔 Nginx 对外提供 `knowledge.wattter.cn`。

## 2. 目标

- 在 GitHub 默认分支推送和人工触发时，以固定提交 SHA 部署到受管服务器。
- 不覆盖既有宝塔站点、Docker Compose 项目、证书、数据库、Blob 或 Wiki 数据。
- GitHub Actions 仅使用仓库 Secrets 建立 SSH 连接；生产运行时密钥仅保留在服务器受限环境文件中。

## 3. 范围

- 新增固定提交 SHA 的 GitHub Actions 工作流、远程部署脚本、宝塔 Nginx 反向代理模板与运维说明。
- 远程部署目录使用 `/opt/wknowledge/app`，Compose 项目名固定为 `wknowledge`，网关只监听 `127.0.0.1:13000`。
- 在首次实际部署前创建独立的受限 SSH 部署身份，配置主机指纹、GitHub Actions Secrets、DNS A 记录和 TLS 证书。

## 4. 安全与运行规则

- Actions 只允许 `main` 和 `workflow_dispatch` 进入生产部署；同一环境并发串行化，较旧运行可取消。
- SSH 必须启用严格主机密钥校验，`ALIYUN_SSH_KNOWN_HOSTS` 由已验证的服务器指纹提供；不得在工作流中使用 `StrictHostKeyChecking=no`。
- 远程脚本只获取 `$GITHUB_SHA` 对应的公开仓库提交，不接收或回显生产 `.env`、数据库密码、凭据主密钥和私钥。
- 首次部署生成并保存 `POSTGRES_PASSWORD`、`WKNOWLEDGE_CREDENTIAL_KEY` 和发布配置到服务器受限文件；仓库、日志和 Actions 输出均不得包含其值。
- 先执行 Compose 配置和 preflight，构建/迁移失败时不重载 Nginx；成功后才替换应用容器。
- 宝塔 Nginx 继续占用公网 80/443；Wknowledge 网关不得公开监听 3000 或 13000。
- 仅镜像构建阶段安装经 APT 签名校验的系统依赖时使用 BuildKit 明确授予的 `network.host`，以适配目标服务器 Docker 默认网络无法解析 Debian 源的已验证故障；Compose 只运行该固定提交构建的本地镜像，运行时网络与对外回环暴露规则不变。

## 5. 验收标准

- 本地：`docker compose config --quiet`、工作流静态校验与 `pnpm format:check` 通过。
- GitHub：公开仓库包含许可证、`.gitignore` 生效、没有 `.env*` 或受管数据；Secrets 仅记录名称，不回显值。
- 服务器：`wknowledge` Compose 服务健康，`127.0.0.1:13000/api/health/ready` 返回成功，既有容器和既有宝塔站点保持运行。
- 域名：`knowledge.wattter.cn` A 记录指向目标公网 IP，证书签发后 HTTPS 访问成功。
- 部署：Actions 运行结论为 `success`，生产健康检查成功；仅“推送已触发”不得表述为部署完成。

## 6. 非范围

- 不迁移已有 Maya、finance-9dayagent 或宝塔管理面板。
- 不自动清理 Docker 镜像、卷、数据库或任何既有站点数据。
- 不把模型 Provider 凭据、第三方 API Key 或生产数据纳入开源仓库。
