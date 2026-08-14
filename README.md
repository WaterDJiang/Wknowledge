# Wknowledge

私有化多模态知识与学习平台。它把文件解析为可追溯的 Markdown LLM Wiki，并为 Agent、Skill、自由问答、学习计划和测评提供统一基础。

## 架构

- `apps/web`：Next.js UI 与 HTTP 控制面。
- `apps/worker`：PostgreSQL/pg-boss 后台执行面。
- `packages/*`：契约、数据库、权限、存储、Wiki、Skill、Agent 和模型路由。
- `runtimes/python`：无 HTTP 服务的文档/OCR/ASR JSON CLI 运行时。
- `data/spaces`：开发环境的受管知识空间文件。

## 快速开始

```bash
cp .env.example .env
# Edit .env: use the same URL-safe random value for POSTGRES_PASSWORD and DATABASE_URL.
# Example: openssl rand -hex 32
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

`pnpm dev` 同时启动 Web 与 Worker。基础 Compose 不发布 PostgreSQL 宿主机端口；仅本地开发时叠加 `docker-compose.dev.yml`，且它只绑定 `127.0.0.1`。完整容器部署使用：

本地 Web 与 Worker 会从仓库根目录的 `.env` 读取尚未由 shell 设置的配置；`.env` 不存在时不会自动填入数据库或模型凭据，相关接口将按配置缺失安全拒绝。

```bash
docker compose up --build
```

## 开发验证

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm eval:wiki
pnpm eval:locators
```

`pnpm eval:wiki` 运行受控 Wiki 评估试点，输出 Recall@10、引用准确率、拒答准确率和 Embedding 调用数；它不等同于 100 份真实资料正式验收。

`pnpm eval:locators` 运行 PDF、PPTX、表格和图片 OCR 的来源定位合成基线。真实资料盲测与人工定位验收仍需另行授权、去敏和标注。

## 私有化维护

- Compose 的 `backup` 仅在 `operations` profile 启用，使用 PostgreSQL 17 Client 生成 PostgreSQL + Blob + 空间 Wiki 的维护窗口快照。
- `preflight` 会在启动前拒绝默认数据库密码、无效凭据主密钥、存储根目录重叠和容量不足；它不会输出密钥或读取业务正文。
- `pnpm db:upgrade:check` 或 Compose `upgrade-check` 只读核验 Drizzle 历史与本地迁移 SQL，再决定是否进入人工确认的迁移步骤。
- `pnpm wiki:schema:check SPACE_ID` 双读历史无清单 v1 与当前有清单 v1 Wiki；只有维护窗口中的 `pnpm wiki:schema:migrate SPACE_ID` 才会原子写入 v1 空间清单。
- 备份、清单校验、恢复保护条件和恢复后验收见 [deploy/operations.md](deploy/operations.md)。恢复不会覆盖已有资料目录，且需要显式确认数据库改写。

## 知识契约

```text
raw/        不可变源文件
compiled/   可重建的结构化解析结果
wiki/       LLM 管理的 Markdown 知识
mappings/   源文件、解析节点和 Wiki 页面映射
```

`compiled/{resourceVersionId}` 使用 CompiledNode v1，必须包含 `content.md`、`nodes.json` 和 `parser-manifest.json`；Worker 在写盘和 Wiki 编译前执行运行时 Schema 校验。

v1 查询使用分层 `index.md`、别名、标签和文本搜索，不使用向量数据库或 Embedding 检索。

## 文档

从 [doc/INDEX.md](doc/INDEX.md) 开始。开发任务按“项目章程 → 分域 Spec → 设计 → 主计划工作包 → 状态台账 → 实现与验收 → 日志”推进，不直接从缺口进入代码。
