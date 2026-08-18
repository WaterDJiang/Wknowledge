# M7-10-M4 Docker 运行时依赖重试 Spec v1

## 1. 关联

- 工作包：`M7-10` 生产加固；关联 `M7-10-M2` gateway 容器运行时验收与 `M7` 私有化部署。
- 发现来源：独立 Compose gateway 验收首次构建期间，Debian 镜像源下载 `fonts-noto-cjk` 出现短暂连接失败，`apt-get install` 立即以 exit code 100 终止，无法进入 Web/gateway 验收。2026-08-18 的真实 Buildx 演练进一步确认：阿里云源连接持续失败时，仅靠同源重试无法构建发布镜像。
- 影响面：`deploy/Dockerfile` 的基础系统依赖安装；不更换基础镜像、系统包或运行时权限模型。

## 2. 目标

- 对暂时性 Debian 包下载失败执行有限、可预测重试，并在首选源持续不可用时回退到 Debian 官方源；最小基础镜像无系统 CA 时，先建立可信 HTTPS 所需的证书链。
- 重试耗尽仍明确失败，不掩盖损坏依赖、无效源或权限问题。

## 3. 规则

- `apt-get update/install` 统一使用 `Acquire::Retries=3`，且非交互安装失败继续返回非零。
- 最小基础镜像尚未含系统 CA 时，仅以已有的 HTTP 源引导安装 `ca-certificates`；APT 仍验证仓库 Release 签名，不得关闭包或仓库认证。该引导失败后清理索引并仅回退一次到基础镜像默认的 HTTP 官方源。
- 证书就位后，先使用现有阿里云源的 HTTPS 端点安装完整运行时包；该次 update/install 失败后，清理 APT 索引并仅回退一次到基础镜像默认的 `https://deb.debian.org` 官方源，再以同样的有限重试执行。
- 不引入新的第三方镜像源、未校验脚本、持久凭据或 `--allow-unauthenticated`。
- 系统包列表、清理 APT 索引和现有 Node/Python 构建顺序保持不变；`ca-certificates` 仅提前引导安装，完整运行时列表仍保持原样。

## 4. 验收标准

- Dockerfile 静态回归要求 update/install 都声明 3 次获取重试、证书引导、首选源失败后的官方源回退，仍保留 `--no-install-recommends` 和 APT 索引清理，且不得关闭 HTTPS 证书校验。
- Docker 构建在镜像源可用时通过；网络持续不可用时明确保留失败日志，不能伪称运行时验收完成。
- 根质量门禁通过。

## 5. 非范围

- 企业镜像仓、离线 apt 缓存、镜像签名策略、系统包版本锁定和生产 Registry 发布。
