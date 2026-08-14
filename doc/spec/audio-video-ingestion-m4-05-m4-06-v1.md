# 音视频入库 M4-05/M4-06 需求 Spec v1

## 1. 当前事实

- 当前可验证入库解析器包括 TXT、Markdown、CSV、PDF、DOCX、PPTX、XLSX、满足前置条件的 WAV、MP3、M4A，以及 MP4。音频只有在知识空间存在健康、启用且数据策略相容的 `speech_to_text` Provider 时才准入；MP4 通过 `ftyp` 签名后可直传或分片上传。
- M4-07 已提供本地 `ffprobe` 媒体元数据与 `audio/video` 时间段 SourceLocator。M4-05 已接通受管 ASR 的 `verbose_json` 分段与整段回退；M4-06 已接通本地流清单、文本型内嵌字幕 cue 和条件化第一音轨转写。
- M4-09 已可按已授权历史 ResourceVersion 播放与时间定位媒体原件；关键帧、OCR、说话人分离和视频视觉理解仍未实现。

## 2. 产品目标

- 音频形成带 `startMs/endMs` 的转写分段，可选说话人，并可从引用跳到对应时间。
- 视频同时处理音轨、已有字幕、关键帧、画面 OCR 和视觉描述；只有音轨转写不能声称完成视频理解。
- 原始媒体不可变，所有派生产物写入 `compiled/{resourceVersionId}/assets`。
- 本地部署可选择本地 ASR；云端 ASR/视频模型必须服从空间数据策略。

## 3. 实施顺序

```text
M2-08 CompiledNode v1
→ M4-07 Python CLI/媒体探测协议
→ M5 模型 Provider 的受管 speech_to_text / video_understanding 能力与空间数据策略审计
→ M4-05 音频 ASR
→ M4-06 视频音轨、字幕和关键帧
→ M4-08/M4-09 来源 API 与媒体播放器
→ M4-10 定位准确率评测
```

## 4. 音频产物

- 媒体元数据：时长、编码、声道、采样率和内容摘要。
- 转写节点：文本、开始/结束毫秒、置信度和可选说话人。
- ASR manifest：引擎、模型、版本、语言、参数和运行时间。
- Wiki 页面：只引用支持相应陈述的转写分段。

## 5. 视频产物

- 媒体元数据、音轨、内嵌/外挂字幕和场景切分。
- 关键帧及其时间点、OCR 区域、画面描述和置信度。
- 音频与画面节点能够按时间窗口关联。
- 视频回答引用必须说明依据来自转写、字幕还是画面。

## 6. 验收标准

- 上传界面只宣称已验证类型；未实现媒体返回明确的 `UPLOAD_MIME_UNSUPPORTED`，不进入必然失败的任务。
- 音频定位误差不超过一个 ASR 分段。
- 视频问题能够区分“说了什么”和“画面出现什么”。
- 点击引用可以打开历史资源版本并跳转到相应时间。
- Worker 中断后媒体任务可以从可验证检查点恢复。
- `local_only` 空间不会把媒体发送给云端 Provider。
- Core 在未获得一次性媒体准入授权时继续以 `UPLOAD_MIME_UNSUPPORTED` 拒绝音频；WAV 直传路由在缺少健康、启用且与空间数据策略相容的 `speech_to_text` Provider 时返回 `409 ASR_PROVIDER_REQUIRED`。两种拒绝都不得创建注定失败的处理任务。
- 首批实际音频入库格式为 WAV、MP3 与 M4A：直传不超过 8 MiB，大文件使用已有分片协议。准入同时检查扩展名、MIME、RIFF/WAVE、MP3 ID3/MPEG 帧或 ISO `ftyp` 容器签名，且必须存在策略相容的 ASR Provider；Worker 先运行媒体探测，再调用受管 ASR，发布媒体元数据与 `transcript` 节点。Provider 的合法 `verbose_json` 分段按各自时间定位；没有、重叠或越界分段时转写按完整媒体时段定位，并标记不具备细粒度分段精度。
