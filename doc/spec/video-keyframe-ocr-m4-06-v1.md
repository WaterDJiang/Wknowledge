# 视频关键帧 OCR M4-06 Spec v1

## 1. 关联计划

- 工作包：`M4-06`，接续已验证的本地关键帧抽取、受权单帧读取和视频时间定位。
- 上游：[视频关键帧时间回源](video-keyframe-traceability-m4-06-v1.md)、[图片 OCR 精确回源](image-ocr-traceability-m4-04-v1.md)。
- 状态：已验证。

## 2. 目标

- 仅对同一 Worker 已抽取的受管 JPEG 关键帧运行本地 OCR，将画面中的可识别文字作为可检索的派生证据入库。
- 每条 OCR 证据必须同时关联同一不可变视频版本、关键帧资产和抽帧时间；不把 OCR 文本表述为视频理解、对象识别或视觉描述。
- OCR 不可用、无文字或输出不合规时，保留原始关键帧发布，不阻断视频容器、字幕或音轨转写。

## 3. 数据与边界

```text
受管 MP4
→ 固定 ffmpeg 抽取受限 JPEG
→ Python/Tesseract 仅读取 Worker 临时 JPEG
→ video SourceLocator + frameId/assetPath/bbox 元数据
→ compiled staging 原子发布
→ Wiki / 受权关键帧面板显示“关键帧 OCR”
```

- 只处理现有最多 8 帧、每帧最多 5 MiB、最长边 960 px 的 JPEG；不接受用户指定帧、路径、OCR 参数、语言包或命令。
- OCR 节点使用 `kind: image` 与同一视频 `startMs/endMs`；`metadata` 固定包含 `source: video_keyframe_ocr`、`contentRole: ocr_line`、`frameId`、`assetPath`、`sampledAtMs`、`imageWidth/imageHeight` 与原关键帧像素 `bbox`。
- Python 仍是无数据库的 JSON CLI；Node Worker 只允许固定解释器、脚本、`--mime image/jpeg` 和 Tesseract 路径。OCR 文本按上传内容处理，不能成为 Agent 指令或权限依据。

## 4. 发布、失败与预览

- 关键帧和 OCR 节点必须使用同一个 `ParserOutput` 经既有 compiled staging/原子发布；不得单独改写已发布节点。
- 关键帧 OCR 失败仅写脱敏 `resource.video_keyframe_ocr.skipped` 审计，保留 `resource.video_keyframes.completed`；不得发布部分 OCR 节点或泄露 Python/Tesseract stderr。
- 受权关键帧列表只读取同版本 `nodes.json`；每帧可展示 OCR 文本与“仅识别此帧文字”的边界说明。点击仍只定位视频时间点，不产生学习事件。

## 5. 验收

- 合成含文字 MP4 产生稳定关键帧 OCR 节点：视频版本、时间、`frameId`、固定 asset 路径和像素 bbox 均正确；同一帧无文字不生成虚构节点。
- OCR 不可用/非法输出不影响原始关键帧、容器、字幕或已可用音轨转写的发布。
- 关键帧面板只在同一历史版本、当前时间范围、受权 Viewer 下显示 OCR；未登录/无权和伪造帧 ID 继续拒绝。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e` 通过。

## 6. 明确后置

- 画面视觉描述、对象/场景识别、视频理解 Provider、跨帧跟踪、字幕-OCR 融合去重与真实视频集人工准确率评测。

## 7. 验证记录

- `apps/worker/tests/video-keyframes.test.ts` 使用本地合成带文字 MP4 验证固定抽帧、关键帧 OCR 节点、同一 `video` 时间定位、`frameId`/asset 路径/bbox 元数据；无文字画面保持原关键帧节点，不产生虚构 OCR。
- `apps/web/unit-tests/video-keyframes.test.ts` 验证面板只聚合同版本、同一关键帧的合法 OCR bbox，拒绝伪造坐标和其他来源。
- 2026-08-14：定向 2 个文件、7 项通过；全仓 59 个测试文件、250 项通过；`pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`pnpm build` 通过；Playwright E2E 19/19 通过。
- 当前没有可复用安全登录浏览器会话，因此真实 MP4 上传 → Worker → Wiki → 关键帧 OCR 面板的人工视觉/授权点击流仍后置，未在本切片宣称完成。
