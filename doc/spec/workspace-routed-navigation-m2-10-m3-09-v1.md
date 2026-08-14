# 工作台独立路由 M2-10/M3-09 实施 Spec v1

## 1. 关联计划

- 工作包：`M2-10 实时处理 UI`、`M3-09 Wiki UI`。
- 用户问题：资料库、知识库、知识问答和学习计划被堆叠在同一个页面中，左侧菜单只是页内锚点，无法形成独立功能页面。
- 本轮性质：工作台信息架构与路由切片，不改变业务 API、数据库或 Worker。

## 2. 目标

- 左侧菜单使用真实 URL 路由，不再使用 `#resources/#wiki/#query` 页内锚点。
- 每个功能页面只呈现本功能内容，支持直接打开、刷新、前进和后退。
- 空间列表、当前空间和全局状态由共享工作台 Layout 管理，页面切换时不重复创建整套外壳。
- 当前菜单项有明确选中状态，页面标题与当前功能一致。

## 3. 路由契约

| 路由                   | 页面职责                             | 当前交付状态 |
| ---------------------- | ------------------------------------ | ------------ |
| `/workspace`           | 重定向到 `/workspace/resources`      | 本轮         |
| `/workspace/resources` | 上传、资源列表、后续处理进度与重试   | 本轮拆分     |
| `/workspace/wiki`      | Wiki 列表、正文阅读、状态和来源      | 本轮拆分     |
| `/workspace/query`     | 知识问答、答案和引用                 | 本轮拆分     |
| `/workspace/learning`  | 学习应用入口及未开放边界，不伪造功能 | 本轮占位     |

## 4. 本轮范围

### 包含

- Next.js App Router 共享 `workspace/layout.tsx`。
- 工作台空间 Context：空间加载、当前空间、创建空间和全局通知。
- 使用 `next/link` 的左侧导航及 `usePathname` 活动状态。
- 将现有上传、Wiki 和问答分别迁移到独立页面。
- 直接访问任一工作台子路由时执行登录检查；未登录跳转登录页。
- 保留现有克莱因蓝主题、响应式侧栏和可访问性规则。

### 不包含

- 修改上传、Wiki 查询和 SourceLocator API。
- SSE 实时进度实现；仍属于 M2-07/M2-10 后续切片。
- 学习计划业务功能；`/workspace/learning` 只展示清晰的阶段说明。
- URL 持久化 `spaceId`；本轮在共享 Layout 生命周期内保持选择，刷新后回到用户首个可用空间。

## 5. 影响面

- `apps/web/app/workspace/layout.tsx`：共享工作台外壳。
- `apps/web/app/workspace/workspace-shell.tsx`：空间状态、侧栏和页面标题。
- `apps/web/app/workspace/{resources,wiki,query,learning}/page.tsx`：独立功能页。
- `apps/web/app/workspace/page.tsx`：默认路由重定向。
- `apps/web/app/globals.css`：独立页面布局和活动导航状态。
- E2E、交付状态和当日日志。

## 6. 验收标准

- `/workspace` 自动进入 `/workspace/resources`。
- 左侧四个菜单分别进入四个独立 URL，不包含 `#` 锚点。
- 资料库页面不渲染 Wiki 阅读器和问答表单。
- 知识库页面不渲染上传框和问答表单。
- 知识问答页面不渲染上传框和 Wiki 阅读器。
- 学习页面明确标记未开放，不出现可误操作的伪功能。
- 当前路由菜单具有 `aria-current="page"` 和可见选中状态。
- 切换功能页后当前空间保持不变；切换空间后当前功能路由保持不变。
- 未登录直接访问 `/workspace/wiki` 最终进入 `/login`。
- 桌面端与窄屏页面均无横向溢出，键盘焦点可见。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 通过。
- `pnpm test:e2e` 和登录态浏览器导航验收通过。
