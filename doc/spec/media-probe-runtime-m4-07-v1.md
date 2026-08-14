# 媒体探测运行时 M4-07 Spec v1

## 1. 关联计划

- 工作包：`M4-07 Python CLI 协议`，为 `M4-05 音频 ASR` 与 `M4-06 视频理解` 提供前置运行时。
- 前置：CompiledNode v1、Python JSON CLI、Worker 受控本地 Blob 路径与不可变 ResourceVersion。
- 当前状态：开发中。本切片只定义本地媒体探测运行时；MP4/WAV 准入与 ASR 由相邻 M4-05/M4-06 切片实现，视频理解仍未实现。

## 2. 目标

- 用本地 `ffprobe` 从单个受控原件读取容器、时长、音视频流和编码元数据。
- 输出经 `ParserOutput` 校验的媒体元数据节点，并以 `audio` 或 `video` 的 `SourceLocator(startMs=0, endMs=durationMs)` 绑定历史 ResourceVersion。
- 建立 Python CLI 的参数、超时、错误码与非信任边界，供后续 ASR、字幕和关键帧模块复用。

## 3. 范围

### 包含

- `runtimes/python/parse_document.py` 的媒体探测分支，只接受 `--input`、`--mime`、`--version-id` 与受运维控制的 `--ffprobe`。
- 支持协议中的 MIME：`audio/mpeg`、`audio/wav`、`audio/mp4`、`audio/x-m4a`、`video/mp4`、`video/webm`、`video/quicktime`。
- 输出一个描述媒体事实的节点：时长、容器、可用的音视频流、编码与码率；不制造不存在的转写文本。
- Worker 为已存在的媒体 ResourceVersion 识别并调用该 CLI；解析选择必须可在不启动队列的情况下，以受控 LocalBlob 夹具独立验证，仍受本地 Blob URI、超时、取消与 ParserOutput 校验约束。

### 不包含

- 上传白名单改变、ASR Provider、转写、说话人分离、字幕抽取、关键帧、OCR、视觉描述和播放器。
- 向云端发送任何媒体、用户指定可执行程序/路径、Python 访问数据库。
- 依据媒体元数据生成 Wiki 知识结论；只有后续经过 ASR/字幕/视觉验证的节点才能支持相应问答。

## 4. 安全与错误约定

- Worker 只对 `local://` Blob 构造绝对输入路径，拒绝越出 Blob 根目录的 URI；Python 再以 `Path.resolve(strict=True)` 固定目标。
- `ffprobe` 只能从 Worker 环境变量或默认可执行名取得，不接受 HTTP/API/上传文件参数。
- 子进程使用参数数组、30 秒超时、无 Shell；stderr 不返回给用户。
- 无法读取时长、没有对应流、MIME 不匹配或 `ffprobe` 失败分别产生稳定内部错误码，最终由既有任务失败脱敏链路呈现。
- 原始媒体和媒体元数据节点均为证据数据，任何其中的文本不得解释为 Agent 指令。

## 5. 验收标准

- 对合成 WAV 与 MP4/WEBM 夹具，CLI 输出通过 `parserOutputSchema`，`resourceVersionId`、MIME、节点 locator 与 manifest 一致。
- WAV 节点的 `audio` locator 从 0 开始、结束时间等于探测时长；视频节点同理使用 `video` locator。
- CLI 不接受未知 MIME、不可读文件、非正时长或越界 Blob 输入；错误不包含用户文件路径或完整 `ffprobe` stderr。
- 本切片不决定上传准入；MP4 已由 M4-06 开放，WAV 仍取决于受管 ASR Provider 的健康与空间数据策略。
- 既有 Worker 取消、超时、ParserOutput 校验和失败脱敏回归不受影响。
- Worker 解析模块对受管 `local://` WAV Blob 选择媒体 CLI；该验证不改变上传准入白名单。

## 6. 后续衔接

- M4-05：已在受管 ASR Provider、数据策略和 ASR manifest 就绪时，用探测结果分段写入 `transcript` 节点。
- M4-06：已补充字幕和条件化第一音轨的时间窗口节点；关键帧和视觉模型仍后置。
- M4-09：媒体播放器只在对应转写/字幕定位存在时跳转时间段，不以本 Spec 的元数据节点冒充可学习内容。
