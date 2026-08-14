# M2-03 资源替换与历史版本 Spec v1

## 1. 关联计划

- 工作包：`M2-03 资源版本`、`M2-10 处理 UI`。
- 依赖：`M2-01` 上传/最终化、`M1-07` 不可变 Blob、`M2-04` Outbox。

## 2. 目标

- 用户可对同一 `Resource` 上传替换文件，系统创建递增的不可变 `ResourceVersion`，不覆盖旧源文件。
- 每个新版本独立入队处理；资料页显示当前版本号、历史数量和可访问历史版本的入口。
- 历史 Wiki、SourceLocator、学习计划、题目、作答和审计始终通过已绑定的 `resourceVersionId` 打开当时证据，不自动切换到新版本。

## 3. 范围

- `POST /api/resources/{resourceId}/versions` 接受不超过 8 MiB 的 multipart 替换文件；大文件先复用 M2-01 分片会话，绑定替换目标属于后续小切片。
- 替换前重新验证资源所在空间 `editor` 权限、文件准入和不可变版本号；创建 Version、ProcessingJob 和 Outbox 在同一事务提交。
- `GET /api/resources/{resourceId}/versions` 返回不含 Blob URI 的版本元数据和每版本最新任务状态。
- 资料列表显示最新版本号及历史数量；用户可在当前页展开版本记录。

## 4. 规则

- 新版本编号为同一 Resource 的最大版本号加一，数据库唯一约束是最后防线。
- 当前新文件与资源任一同编译模式版本内容哈希相同，返回 `duplicate=true`，不创建冗余版本或任务。
- 同空间另一资料已有相同哈希时可复用该不可变 Blob URI，但仍创建当前 Resource 的独立版本、任务和审计链。
- 替换只更新逻辑 Resource 的处理状态；不修改旧 Version、旧 Blob、旧 compiled、已发布 Wiki 或任何历史引用。
- 每次读写均通过 Resource → KnowledgeSpace 验证权限；API 不返回 Blob URI、文件系统路径或内部执行令牌。
- 既有资料需要改变 Wiki 编译模式时，使用 `resource-recompile-profile-m2-03-m3-03-v1.md` 创建复用 Blob 的新版本；不得把 `compileProfile` 原地改写到旧版本。

## 5. 非范围

- 大文件替换分片会话绑定、版本回滚为当前版本、逻辑删除、批量替换。
- 自动判定新旧文档语义差异、自动覆盖已审核 Wiki 页面。
- 历史原文件浏览器预览；该能力属于 M4 来源预览。
- 选择历史任意版本重新编译；当前只支持从最新版本创建新模式版本。

## 6. 验收

- 初始上传后替换生成同一 Resource 的 Version 2、新 ProcessingJob，Version 1 Blob 与记录仍存在。
- 同一内容重复替换不产生 Version 3 或第二个任务；另一资料相同内容不越权读取或合并 Resource。
- 未登录 401、无资源所在空间权限 403、未知资源 404；响应没有 Blob URI。
- 用户可在资料页展开看到 Version 1/2 的文件名、类型、大小、时间、编译模式及各自最新任务状态。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 和 `pnpm test:e2e` 通过。
