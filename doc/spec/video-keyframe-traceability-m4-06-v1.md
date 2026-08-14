# 视频关键帧时间回源 M4-06 Spec v1

## 1. 关联计划

- 工作包：`M4-06`，依赖 MP4 受管上传、M4-07 本地媒体探测、不可变 `ResourceVersion` 和已发布 compiled 目录。
- 状态：开发中。本切片只抽取可浏览的本地 JPEG 关键帧；不调用 `video_understanding`、OCR、视觉描述或任何云端模型。

## 2. 目标

- 对已入库的受管 MP4 以固定、有限的时间间隔抽取 JPEG 关键帧，作为“该时刻的原始画面”浏览证据。
- 每帧使用同一历史版本的 `video startMs/endMs` SourceLocator，并可在来源页打开图片或跳转原件播放时间。
- 原始视频保持不可变；派生 JPEG 只写入 compiled staging，随 `nodes.json` 原子发布。

## 3. 数据与边界

```text
受管 local:// MP4
→ ffprobe 取得总时长与视频流
→ Worker 固定 ffmpeg 参数抽帧
→ staged compiled/assets/keyframes/*.jpg + image CompiledNode
→ 原子发布
→ 受权列表/单帧 API → 来源播放器时间跳转
```

- 单文件最多 512 MiB、时长最多 2 小时；每个视频最多 8 帧，固定为每 60 秒一个起点采样，至少一帧。
- 每帧 JPEG 最多 5 MiB，最长边不超过 960 px；资产名固定为 `keyframes/frame-###.jpg`，不接受用户路径、文件名、ffmpeg 参数或时间点。
- 节点 `kind: image`，但 locator 仍为 `video`；`metadata.source = video_keyframe` 只说明“原始画面帧”，绝不表示画面已识别、转写或理解。
- API 只从同版本 `nodes.json` 中确认关键帧节点后读取匹配的 compiled asset；不接受宿主路径、asset 路径或版本 ID 作为请求参数。

## 4. 失败与安全

- 无视频流、超限、原件不可读、ffmpeg 超时/失败或空/超限 JPEG 均不生成半套帧；视频的容器、字幕与可用音轨转写仍照常可发布。
- Python 继续只负责媒体探测/字幕；关键帧由 Node Worker 以参数数组调用受运维控制的 ffmpeg，禁用 stdin、无 Shell、单帧 30 秒超时。
- 关键帧、视频封面和画面中文字都是不可信资料，不能成为 Agent/Skill 指令、权限依据或模型结论。
- API 不返回 Blob URI、compiled 相对路径、宿主路径、ffmpeg stderr 或未授权历史版本。

## 5. 验收

- 合成 MP4 产生受限 JPEG、稳定时间定位节点和可验证的 ParserOutput；静音视频同样可抽帧，不依赖 ASR Provider。
- 关键帧 asset 仅在持有执行租约时随 compiled 发布；失租、越界 Blob URI 或工具失败不发布 asset/节点。
- 未登录为 401、无空间权限为 403、非视频或没有匹配帧为 400/404；历史版本只能返回自身帧。
- 前端按当前视频来源范围加载帧、点击帧定位原件；不将查看帧记为学习进度。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e` 通过。

## 6. 后置

- 关键帧 OCR、视觉描述、视频理解 Provider、关键帧语义检索、镜头检测、外挂封面和真实视频集的人工准确率评测。
