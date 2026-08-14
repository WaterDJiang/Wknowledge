# 视频内嵌字幕提取 M4-06 Spec v1

## 1. 关联计划

- 工作包：`M4-06`，前置 MP4 受管上传、受控 `ffprobe` 媒体探测。
- 状态：开发中。

## 2. 目标

- 对已入库 MP4 的文本型内嵌字幕流，使用受运维控制的本地 `ffmpeg` 提取为带 `video startMs/endMs` 的证据节点，使字幕内容可进入 Markdown Wiki、查询和来源播放器。
- 清楚区分“字幕中写了什么”与“视频画面出现什么”：本工作包只提供前者，不提供 ASR、OCR、关键帧、视觉描述或视频理解。

## 3. 范围

- Python CLI 先由 `ffprobe` 列出 subtitle stream，再按 stream index 用参数数组调用本地 `ffmpeg` 输出 SRT。
- 只接受可解析的时间码与非空字幕 cue；每个节点包含受限的语言/编码/流索引元数据和不可变 ResourceVersion 的视频时间范围。
- 无字幕流、无法转成文本的字幕流、空/无效 cue 都不视为解析失败，保留媒体元数据并记录受限的提取结果摘要；不向浏览器回传命令、stderr、文件路径或未受控 URI。
- 原始字幕文本和容器标签均是数据：不得作为 Agent、Skill 或系统指令执行；仅作为来源证据供检索与阅读。

## 4. 安全与质量规则

- `ffmpeg` 位置只能由 Worker 配置提供，不接受 HTTP/API/上传参数；命令无 Shell、禁用标准输入、每流 30 秒超时。
- 文本产物上限为单流 2 MiB、每个 cue 4,000 字符、每流最多 500 个 cue。超过限制的流标记为未提取，不生成被截断而可能误导的知识证据。
- 仅使用 `video` SourceLocator，时间范围为合法、正时长且落在媒体总时长内；不得伪造音频转写的精度或说话人信息。
- 已上传的 MP4 不发送给模型、网络或 Provider；镜像仅安装本地 FFmpeg 工具。

## 5. 验收

- 合成含 `mov_text` SRT 字幕的 MP4 产生一个或多个 `transcript` 节点；内容、时间范围、语言和 stream index 正确，节点通过 `parserOutputSchema`。
- 不含字幕的 MP4 仍只产生媒体元数据；无法抽取/超限字幕不会导致视频资源任务失败或产生不完整 cue。
- 字幕节点可通过既有 Wiki 编译和 `SourceLocator` 打开同一历史视频版本的正确时间范围。
- 全过程无模型/网络调用；Python CLI、Worker、类型、回归、构建与 E2E 门禁通过。

## 6. 不包含

- 外挂字幕上传、音轨 ASR、说话人分离、关键帧、OCR、画面描述与 `video_understanding`。
