# Wiki 人工审核锁 M3-05 Spec v1

## 1. 关联计划

- 工作包：`M3-05 人工审核锁`，并补充 `M3-08 Wiki API`、`M3-09 Wiki UI`。
- 前置能力：Wiki 页面稳定 ID、原子发布、只读浏览和空间 RBAC 已存在。
- 本轮性质：M3-05 的首个纵向切片，不代表版本历史、可视化 diff 和冲突裁决全部完成。

## 2. 目标

- 空间 `editor` 及以上角色可以批准草稿 Wiki 页面，也可以把已批准页面重新打开为草稿。
- 已批准页面必须携带审核人和审核时间，并在知识库页面明确显示。
- Worker 再次编译同一稳定页面时，不得静默覆盖人工批准的正文和 Frontmatter。
- `viewer`、`learner` 只能阅读，不能改变审核状态。

## 3. 本轮范围

### 包含

- Frontmatter 增加可选 `reviewedAt` 和 `reviewedBy`。
- Wiki 包增加原子审核状态变更操作。
- 编译器遇到 `reviewed + humanVerified` 页面时保留已发布文件；编译结果返回被审核锁保护的页面 ID。
- `PATCH /api/spaces/{spaceId}/wiki/pages/{pageId}/review` 执行 `approve` 或 `reopen`。
- 审核 API 要求空间 `editor` 权限，并写入组织审计事件。
- Wiki 阅读器显示审核信息和审核操作，成功后刷新列表与正文。

### 不包含

- Markdown 正文在线编辑。
- 待发布版本持久化、逐行 diff 和人工合并；归入 M3-05b/M3-08b。
- `conflicted` 页面裁决；归入 M3-04。
- 多进程空间级数据库锁；归入 M3-06。

## 4. 状态规则

```text
draft + humanVerified=false
  -- approve --> reviewed + humanVerified=true + reviewer/time

reviewed + humanVerified=true
  -- compile --> 保留人工确认页面，报告 reviewLocked
  -- reopen  --> draft + humanVerified=false，清除 reviewer/time
```

- 只有 `draft` 可以批准；重复批准返回 `WIKI_REVIEW_STATE_INVALID`。
- 只有 `reviewed` 可以重新打开；其他状态返回 `WIKI_REVIEW_STATE_INVALID`。
- 审核写入使用 staging、Lint 和目录原子替换，失败不得留下半写页面。
- 审核人保存内部用户 UUID，不在 UI 暴露服务器路径或密钥。

## 5. 影响面

- `packages/contracts`：审核动作和 Frontmatter 契约。
- `packages/wiki`：审核状态更新、审核锁保护、单元测试。
- `apps/web`：审核 API、审计事件和阅读器交互。
- 文档：Spec 索引、交付状态、文档入口和实施日志。

不修改数据库 Schema、原始资源、CompiledNode、上传和模型路由。

## 6. 验收标准

- 草稿页批准后，详情返回 `status=reviewed`、`humanVerified=true`、审核人和审核时间。
- 再次编译同一页面且生成正文不同，已批准正文、来源和审核元数据保持不变，结果包含该页面 ID。
- 重新打开后再次编译可以更新页面，并恢复为未审核草稿。
- 未登录审核返回 401；低于 `editor` 返回 403；未知页面返回 404。
- 无效状态迁移返回 409，不伪装成功。
- 审核成功写入 `wiki.page.approved` 或 `wiki.page.reopened` 审计事件。
- 页面在审核请求期间禁用按钮；成功后状态、详情和列表同步刷新；失败显示可操作错误。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 通过。
- 浏览器验证批准与重新打开各一次，控制台无错误且页面无横向溢出。

## 7. 后续切片

- M3-05b/M3-08b：保存待发布提案、版本快照、逐行 diff 和审批决定。
- M3-04：冲突知识并列展示和人工裁决。
- M3-06：数据库空间锁和跨进程串行发布。
