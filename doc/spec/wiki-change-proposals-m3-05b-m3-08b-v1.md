# Wiki 变更提案、版本快照与 Diff M3-05b/M3-08b Spec v1

## 1. 关联计划

- 工作包：`M3-05 人工审核锁`、`M3-08 Wiki API`、`M3-09 Wiki UI`。
- 前置：M3-05 已实现批准、重新打开与已审核页面的重编译保护。
- 本轮性质：补齐已审核页面的受控变更链路；不实现在线正文编辑、冲突裁决或跨进程发布锁。

## 2. 目标

- 编译器遇到已审核页面的新内容时，保存待发布提案，而不是静默丢弃新内容或覆盖已发布页面。
- 每次首次批准和每次接受提案均保存不可变 Markdown 版本快照。
- 编辑者可查看当前已发布版本与候选版本的逐行差异，并显式接受或拒绝提案。
- 接受提案前必须验证基线版本仍是当前版本，避免旧提案覆盖后续人工修改。

## 3. 范围

### 包含

- 在知识空间受管目录保存提案 Markdown、基线 Markdown、快照 Markdown 及最小元数据；不把 Wiki 正文写入 PostgreSQL。
- 已审核页面重编译时按稳定语义摘要判断是否变化；仅 `lastCompiled`、审核状态等易变元数据变化不创建提案。
- 提案具有 `pending`、`accepted`、`rejected`、`stale` 状态，重复相同编译幂等复用同一待处理提案。
- 提供提案列表、详情、逐行 diff、版本快照列表和接受/拒绝 API。
- 提案详情仅对 `editor` 及以上开放；只读页面继续对现有可读角色开放。
- 接受提案使用 staging、Frontmatter/链接/来源 Lint 和原子发布；成功后写审核事件和版本快照。
- Wiki 阅读器为编辑者提供“待审核变更”入口、摘要和对比面板。

### 不包含

- 两人协同编辑、行级合并、评论、冲突事实裁决和多进程数据库发布锁。
- 对草稿页直接编辑 Markdown。
- 已废弃版本恢复、提案撤回、批量审核和通知中心。
- M4 音视频解析、M5 多轮 Agent、M6 学习计划与测评功能。

## 4. 数据与状态规则

```text
reviewed page + compile semantic change
  -> pending proposal(base snapshot + candidate Markdown + source mapping)

pending proposal + accept + base digest matches current
  -> snapshot current
  -> atomic publish candidate as reviewed
  -> snapshot accepted version
  -> accepted

pending proposal + reject
  -> rejected; current Wiki unchanged

pending proposal + current digest differs
  -> stale; reject/accept 均不得覆盖 current
```

- 提案和快照目录在 `data/spaces/{spaceId}/reviews/pages/{pageId}/`；Markdown 保存完整页面内容，JSON 只保存状态、摘要、时间、操作者和来源节点映射。
- 审核后的当前页面仍是 `data/spaces/{spaceId}/wiki/` 下的唯一已发布知识正文。
- 首次批准草稿时创建其首个 `approved` 快照；重新打开不删除历史快照。
- 接受候选时使用当前决策者与当前时间更新审核元数据；候选本身不能伪造审核者。
- 提案基线只可读取，不可在接受过程中修改；基线摘要失配时返回 `WIKI_PROPOSAL_BASE_STALE`。
- 检索与问答只能读取发布 Wiki，不得读取 `reviews/` 下未接受候选。

## 5. API 与权限

- `GET /api/spaces/{spaceId}/wiki/pages/{pageId}/proposals`：`editor` 及以上，返回提案和快照摘要。
- `GET /api/spaces/{spaceId}/wiki/pages/{pageId}/proposals/{proposalId}`：`editor` 及以上，返回基线、候选与逐行 diff。
- `PATCH /api/spaces/{spaceId}/wiki/pages/{pageId}/proposals/{proposalId}`：`editor` 及以上，动作 `accept` 或 `reject`。
- 未登录返回 401；无空间权限返回 403；不存在页面/提案返回 404；非 pending 或基线过期返回 409。
- 接受/拒绝写组织审计事件，记录页面、提案、动作和版本摘要，不记录 Wiki 正文。

## 6. 影响面

- `packages/contracts`：提案、快照、逐行 diff 和决策输入输出 Schema。
- `packages/wiki`：编译时提案生成、快照、读取、决策和单元测试。
- `apps/web`：提案 API、审计、阅读器审核对比组件。
- `doc/`：索引、交付状态和执行日志。

不修改数据库 Schema、原始资源、CompiledNode、上传和模型路由。

## 7. 验收标准

- 已审核页面重编译且正文/来源发生语义变化后，已发布页面不变并生成一个 `pending` 提案。
- 相同输入重复编译不重复创建 pending 提案；仅时间戳变化不创建提案。
- 提案详情包含可读的逐行 added/removed/unchanged diff、基线与候选摘要，且不泄漏服务器绝对路径。
- 接受提案后发布候选内容、保留 `reviewed + humanVerified`、更新审核元数据，并产生前后快照。
- 拒绝提案后当前发布页面和现有快照不变，提案状态可追溯为 `rejected`。
- 在提案生成后人工改变当前已审核页面时，接受旧提案返回 409，不能覆盖当前内容。
- 草稿首次批准创建快照；重新打开不清除历史。
- Viewer 不可读取候选内容或执行决策；公开查询和索引不读取候选内容。
- 阅读器在桌面和 390px 移动视口可查看差异与决策，键盘可操作且无横向溢出。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 通过；完整交互追加 `pnpm test:e2e`。

## 8. 后续

- M3-04：对互相矛盾的来源建立并列事实与裁决流程。
- M3-06：对同一空间编译/审核的跨进程串行发布锁。
- M3-08 后续：版本恢复、提案批量审阅与通知。
