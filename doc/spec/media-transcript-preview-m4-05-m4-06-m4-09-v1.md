# 媒体字幕与转写预览 M4-05/M4-06/M4-09 Spec v1

## 1. 关联计划

- 工作包：`M4-05`、`M4-06`、`M4-09`，依赖历史 ResourceVersion、SourceLocator、Worker 编译产物和受权来源预览。
- 状态：开发中。本切片将已处理的字幕/音轨转写呈现在媒体原件播放页；不调用模型、不重新解析媒体、不产生视觉理解。

## 2. 目标

- 让学习者在播放音频/视频时读取同一历史版本已有的字幕或转写片段，并可点击片段跳转该时间段。
- 使文本证据、原件播放和时间定位保持同一 `ResourceVersion`，不使用搜索缓存或后续版本替代历史内容。

## 3. API 与范围

```text
GET /api/source-locators/media-transcript?ref=wk://source/...
```

- 只接受 `audio` 或 `video` SourceLocator；解析 `ref` 后先按 `ResourceVersion → Resource → KnowledgeSpace` 验证 `viewer` 权限，再读取受管 `compiled/{resourceVersionId}/nodes.json`。
- 只返回相同 ResourceVersion、相同媒体类型且与当前定位时间段相交的 `transcript` 节点，最多 200 条；返回 `startMs`、`endMs`、`content`、`sourceKind`。
- `content` 以纯文本渲染；上传字幕/转写仍是不可信资料，不能成为 Agent 指令、权限、模型输入或画面结论。
- 无编译产物、没有媒体文本或暂不支持定位时返回空 `items`，不把该情形作为原件预览失败。

## 4. 前端行为

- 原件播放器下方显示“字幕与转写”区，并按当前播放时间高亮相交片段；加载/空状态解释事实，不承诺画面理解。
- 点击片段将播放器定位到其 `startMs`；播放器到达已选片段的 `endMs` 时仍遵循来源定位范围暂停。
- 学习计划中的媒体位置记录只来自实际播放时间，不因打开或点击文本片段自动写入进度。

## 5. 安全与验收

- API 不接受路径、版本 ID、MIME 或节点 ID 作为替代输入；响应不泄露 Blob URI、受管目录或原始错误。
- 无权访问为 403，未登录为 401，非媒体引用为 400；历史版本继续返回其自身已编译文本。
- 重叠筛选、时间定位和空状态有单元回归；`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 通过。
