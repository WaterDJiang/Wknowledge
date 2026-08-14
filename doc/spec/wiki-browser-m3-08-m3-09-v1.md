# Wiki 浏览器 M3-08/M3-09 实施 Spec v1

## 1. 关联计划

- 工作包：`M3-08 Wiki API`、`M3-09 Wiki UI`。
- 用户问题：已处理资料已经生成 Markdown Wiki，但工作台只能查看资源状态，无法浏览知识页面。
- 本轮性质：M3-08/M3-09 的第一个只读纵向切片，不代表两个工作包全部完成。

## 2. 目标

- 已登录且拥有空间读取权限的用户可以浏览该空间已发布的 Wiki 页面。
- 用户可以按标题、别名、标签、正文和状态筛选页面。
- 用户可以用稳定页面 ID 打开正文、元数据和来源，不接触服务器文件路径。
- 工作台明确区分“资料库”“知识库”“知识问答”。

## 3. 本轮范围

### 包含

- Wiki 包提供页面列表、筛选和按稳定 ID 读取能力。
- `GET /api/spaces/{spaceId}/wiki/pages` 返回可见页面摘要。
- `GET /api/spaces/{spaceId}/wiki/pages/{pageId}` 返回页面正文和 Frontmatter。
- 两个接口执行登录和空间 `viewer` 权限检查，并使用统一错误格式。
- 工作台新增知识库导航、页面列表、状态筛选、搜索、正文阅读和来源面板。
- Markdown 正文以 React 节点安全渲染，不执行原文 HTML 或脚本。

### 不包含

- 页面编辑、版本历史、diff、人工审核和冲突裁决。
- 来源原文件内容预览；本轮来源入口继续使用已有 SourceLocator 解析接口。
- Worker 完成后的 SSE 自动刷新；归属 `M2-07/M2-10`。
- 分域索引重构和数据库 Wiki 镜像表。

## 4. 影响面

- `packages/wiki`：只读目录和页面读取服务。
- `packages/contracts`：Wiki 列表筛选及 API 输出契约。
- `apps/web/app/api/spaces/{spaceId}/wiki`：授权 Route Handlers。
- `apps/web/app/workspace`：知识浏览器组件和工作台布局。
- 文档：Spec 索引、交付状态和当日日志。

不修改 PostgreSQL Schema、上传流程、Wiki 编译发布协议和原始文件。

## 5. 验收标准

- 空间内存在已发布页面时，工作台“知识库”显示页面数量、标题、类型、状态、标签和来源数。
- 选择页面后显示 Markdown 正文、更新时间、来源标记和可点击来源列表。
- 搜索可以命中标题或正文；状态筛选可以只显示指定状态。
- 空空间显示明确空状态；加载失败显示可重试错误。
- 未登录访问 Wiki API 返回 401；无空间权限返回 403；未知页面返回 404。
- 页面详情仅接受稳定页面 ID，不能通过 `../` 或绝对路径读取任意文件。
- `index.md`、`log.md` 和 deprecated 页面默认不进入列表。
- 单元测试覆盖列表、筛选、详情、未知 ID 和路径穿越输入。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 通过。
- 浏览器验证登录后可以从工作台打开现有 Wiki 页面和来源。

## 6. 后续切片

- M3-08b：页面版本、diff、审核 API 与审计事件。
- M3-09b：审核队列、diff 阅读和 editor 审批界面。
- M2-07/M2-10：上传任务 SSE 驱动资源和 Wiki 列表自动刷新。
