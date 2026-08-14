# Wiki 冲突事实与人工裁决 M3-04 Spec v1

## 1. 关联计划

- 工作包：`M3-04 冲突策略`，并补充 `M3-08 Wiki API`、`M3-09 Wiki UI`。
- 前置：M3-03 的稳定页面与来源定位，以及 M3-05/M3-05b 的审核、快照和原子发布。
- 本轮只提供可追溯的人工冲突声明、并列展示和裁决；不声称能自动识别自然语言矛盾。

## 2. 目标

- 编辑者可把两份已发布 Wiki 页面的互斥结论标记为同一冲突，并保留双方 Markdown 与 SourceLocator 证据。
- 冲突页面以 `conflicted` 并列展示；查询能检索它们，但不得把任一方伪装为唯一结论。
- 编辑者可选择一方，或明确保留并列结论；所有决定可追溯且不覆盖原始资源。

## 3. 范围

### 包含

- `reviews/conflicts/{conflictId}/` 保存冲突记录、双方 Markdown 快照、来源摘要、状态和裁决。
- 创建冲突时原子将两个当前页面标记为 `conflicted`，清除旧审核元数据；旧审核信息留在快照。
- 页面摘要和详情返回 `conflictIds`；同一页面允许关联多个冲突。
- 冲突详情对空间 `viewer` 开放，创建和裁决仅限 `editor` 及以上。
- 裁决动作：`select_left`、`select_right`、`keep_parallel`。
- 选择一方后 winner 为 `reviewed + humanVerified`、另一方为 `deprecated`；保留并列时双方保持 `conflicted`，冲突记录为 `parallel`。
- 阅读器显示冲突、双方来源和裁决入口；查询证据带 `conflicted` 标记。
- 创建/裁决执行 staging、Frontmatter 与来源 Lint、原子发布；审计不存正文。

### 不包含

- LLM/Embedding 自动识别矛盾、多方裁决、行级合并、评论、投票或通知。
- 自动改写 Wiki 正文、删除原始资源、删除冲突快照和跨进程空间锁（M3-06）。

## 4. 状态规则

```text
page A + page B
  -- declare --> A=conflicted, B=conflicted, conflict=open

open
  -- select_left --> A=reviewed, B=deprecated, conflict=resolved
  -- select_right --> A=deprecated, B=reviewed, conflict=resolved
  -- keep_parallel --> A=conflicted, B=conflicted, conflict=parallel
```

- A/B 必须是同空间、不同且有 SourceLocator 的已发布页面。
- 同一页面对不能同时存在两个未关闭冲突；裁决后可再次声明新冲突。
- 当前页面不是 `conflicted` 时，旧记录不得裁决，返回 `WIKI_CONFLICT_STATE_INVALID`。
- `keep_parallel` 不升级为已审核事实；后续检索、对话和学习能力必须保留冲突标记。

## 5. API

- `GET /api/spaces/{spaceId}/wiki/conflicts/{conflictId}`：`viewer`，读取详情。
- `POST /api/spaces/{spaceId}/wiki/conflicts`：`editor`，输入左右页面 ID。
- `PATCH /api/spaces/{spaceId}/wiki/conflicts/{conflictId}`：`editor`，输入裁决动作。

## 6. 验收标准

- 创建冲突后双方均为 `conflicted`，详情保留正文、页面 ID 和 SourceLocator。
- 重复创建同一开放页面对返回 409，不创建第二个冲突。
- 三个裁决准确改变页面/冲突状态，记录裁决者和时间；原始资源不变。
- 未登录 401；viewer 可读不可裁决；未知对象 404；无效状态/重复冲突 409。
- 冲突查询证据带标记，生成式回答提示并列结论且不声称唯一答案。
- 单元测试覆盖创建、重复拒绝、三种裁决、原子失败回滚和来源快照；API/E2E 覆盖未登录与权限。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e` 通过。

## 7. 后续

- M3-06：多进程空间锁、发布 manifest 与并发编译串行化。
- M5：对话 Agent 将 `conflicted/parallel` 作为引用策略，不代替人工裁决。
