# M2-03/M3-03 既有资料重新编译模式 Spec v1

## 1. 关联计划

- 工作包：`M2-03 资源版本`、`M2-04 事务补偿`、`M3-03 编译器`、`M3-09 Wiki UI`。
- 动机：历史资料默认以 `reference` 入库；用户需要把同一不可变原文件重新整理为 `knowledge` 或 `case`，以生成正确的 Wiki 页面粒度，而不重新上传或篡改历史证据。

## 2. 目标

- 编辑者可从资料库对某份资源的当前版本选择新的编译模式并重新处理。
- 系统创建同一 `Resource` 的新不可变 `ResourceVersion`，复用当前版本的 Blob URI、文件哈希、名称、MIME 和大小，只改变不可变的 `compileProfile`。
- 新版本、ProcessingJob 和 Outbox 在同一事务创建；Worker 像新上传一样重新解析、写 compiled 和编译 Wiki。
- 历史版本、已发布 Wiki、SourceLocator、审核记录与学习证据不被覆盖或改写。

## 3. 范围

- 新增 `POST /api/resources/{resourceId}/recompile`，JSON 输入仅含 `compileProfile`。
- 服务端按 Resource 锁读取当前最高版本；新版本号递增，新的 `resource_version` 复用已有 Blob URI，不复制或删除 Blob。
- 若同一 Resource 已有同一 SHA-256 与目标模式的版本，返回 `duplicate=true`，不创建版本、任务或 Outbox。
- 资料库提供目标模式选择和“重新整理”入口；当前模式不能提交，处理中时禁用。
- API 返回版本和任务元数据，不返回 Blob URI、真实路径或源文件正文。

## 4. 规则

- 重新编译只允许 `editor` 及以上角色；必须经过同源、限流与资源所在空间授权。
- 只基于当前最高版本创建新版本；历史版本的重新编译、版本回滚和大文件替换绑定不在本切片范围。
- `compileProfile` 是新版本的不可变处理意图。相同原文件的不同模式可并存，不改变去重语义。
- 若源 Blob 后续缺失，Worker 按既有任务失败流程处理；重编译 API 不猜测或静默修复 Blob。
- Resource 名称保持当前版本原始文件名；状态进入 `queued`，资料页通过已有 SSE 显示进度。

## 5. 影响面

- `packages/contracts`：重编译输入 Schema。
- `packages/core`：在事务中创建复用 Blob 的新版本、Job 与 Outbox。
- `apps/web`：授权 API、资料列表动作和版本刷新。
- `apps/worker`：复用既有 `resource.process`，不添加新的长任务逻辑。

## 6. 验收

- reference 版本选择 knowledge 后创建同一 Resource 的递增版本，Blob URI 保持相同、compileProfile 为 knowledge、存在新的 ProcessingJob/Outbox。
- 重复请求相同目标模式不创建第二个版本或任务。
- 旧版本、旧 Blob URI 与旧 SourceLocator 记录保持不变。
- 未登录 401、无权限 403、未知资源 404；非法模式 400；所有响应不含 Blob URI。
- 资料页可选择新模式、看到重新处理排队状态与新版本模式。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 和 `pnpm test:e2e` 通过。

## 7. 非范围

- 重写历史 Wiki、自动删除旧页面、自动选择模式或 LLM 语义判断。
- 历史任意版本选择、版本回滚、文件内容替换、分片替换和来源原文件预览。
- 向量检索、Embedding 或跨空间 Blob 复用。
