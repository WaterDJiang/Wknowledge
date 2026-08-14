# MP4 受管上传与媒体探测 M4-06 Spec v1

## 1. 关联计划

- 工作包：`M4-06`，承接 [视频流清单 M4-06 Spec](video-stream-inventory-m4-06-v1.md) 与 `M4-07` 媒体探测运行时。
- 状态：开发中。

## 2. 目标

- 让用户可以上传 MP4 资料（8 MiB 内直传，超过后走既有分片上传），由 Worker 只提取容器、时长、音轨和内嵌字幕流元数据，并形成可打开的 `video` 时间 SourceLocator。
- 修复分片上传的媒体准入一致性：音频/视频的权限判断在创建会话和 Worker 最终化时都重核，不能因分片流程绕过直传规则。
- 本切片不调用 ASR、视觉模型、OCR、关键帧或字幕正文抽取；流清单与媒体元数据不能被写成“视频已理解”的知识结论。

## 3. 范围

### 包含

- `.mp4` / `video/mp4` 的扩展名、MIME 和 ISO Base Media `ftyp` 容器签名校验。
- 资料处理台明确显示 MP4 为“仅提取媒体结构与时间定位”；支持现有 100 MiB 上限和分片续传。
- 分片会话创建时检查 MP4 是否为已允许的本地探测格式；最终化时再次用完整文件签名校验。
- Worker 使用既有受控 `ffprobe` CLI，写入媒体元数据节点、历史版本 `video` SourceLocator，并供既有原件预览播放器打开。
- 部署运行时安装 `ffprobe` 所属的本地 FFmpeg 包。

### 不包含

- MP3/M4A/WEBM/MOV 上传；它们需各自的签名与兼容性验收。
- 视频音轨 ASR、字幕正文、关键帧、OCR、视觉描述、`video_understanding` Provider 或任何视频模型调用。
- 自动从媒体元数据生成 Wiki 知识、学习完成事件或画面问题答案。

## 4. 核心规则

- 只有 `.mp4` + `video/mp4` + 受限位置的 `ftyp` 标识三者一致才准入；伪造扩展/MIME/容器在 Blob、数据库和队列之前拒绝。
- MP4 准入不依赖云模型、模型密钥或空间 `dataPolicy`，因为 Worker 仅在本地读取受管 Blob 并运行 `ffprobe`；这一许可不授权将媒体发送到任何 Provider。
- 音频依旧要求同组织、启用、健康、`speech_to_text` 能力且与空间数据策略相容的 Provider。分片音频会话同样必须在创建和最终化时重核；未满足时返回 `ASR_PROVIDER_REQUIRED`，不产生处理任务。
- 所有媒体原始文件保持不可变，流清单和媒体节点写入派生产物；浏览器只接收平台受管原件 URL，禁止绝对本机/服务器路径。
- 解析失败走既有任务重试/失败链路，错误不暴露 `ffprobe` stderr、Blob URI、文件路径或模型凭据。

## 5. 验收

- MP4 的直传与分片最终化均创建不可变 ResourceVersion 和资源处理任务；非 MP4、伪造 `ftyp`、错误 MIME 和未重核通过的分片均无 Blob 持久化/资源/任务。
- WAV 分片上传在无可用 ASR Provider 时于会话创建或最终化返回 `ASR_PROVIDER_REQUIRED`，不得绕过直传规则。
- 合成 MP4 经 Worker 输出通过 `parserOutputSchema`，含 `video` SourceLocator、时长和流清单，但不含 transcript、OCR 或视觉理解节点。
- Docker 镜像包含 `ffprobe`；类型、单元/集成、构建与 E2E 门禁通过。

## 6. 后续

- M4-06 已在经数据策略允许时将第一音轨临时转为 WAV，使用 ASR 时间戳和转写审计将“说了什么”加入视频资料；无 Provider 或音轨时保留容器/字幕证据并跳过。
- M4-06 后续独立实现字幕正文、关键帧/OCR 和视觉理解；每项都有自己的来源、数据策略、模型审计和准确率验收。
