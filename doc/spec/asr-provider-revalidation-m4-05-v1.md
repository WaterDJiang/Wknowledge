# ASR Provider 运行前重核 M4-05 Spec v1

## 1. 目标

- 让 WAV 上传准入与 Worker 执行使用同一条“可用 ASR Provider”规则，避免文件入队后把音频发送给已停用、不健康或不符合空间数据策略的 Provider。
- 在转写阶段向资料处理台显示明确状态；Provider 在排队后失效时以稳定业务错误结束，不泄露 Provider、路径、凭据或底层网络错误。

## 2. 范围

- 可用 Provider 必须同时属于同一组织、启用、健康、声明 `speech_to_text`，并且位置与空间 `dataPolicy` 相容：本地 Provider 始终可用；云端仅在 `cloud_allowed` 可用。
- 上传 WAV 前和 Worker 发起转写前均查询该规则；Worker 在确认之前不得读取原始音频 Blob 或创建模型请求。
- Worker 阶段增加 `audio_transcribe`，资料处理台显示“正在转写音频”。
- 排队后没有可用 Provider 时记录 `ASR_PROVIDER_REQUIRED`；该错误可由既有安全重试/人工重新处理链路恢复。

## 3. 不包含

- 不开放 MP3/M4A、视频上传、说话人分离、时间戳分段、字幕抽取、关键帧、OCR 或视频理解。
- 不伪造 Provider 健康检查、转写结果、模型调用审计或已登录浏览器验收。

## 4. 验收

- `local_only` 与 `cloud_allowed_after_redaction` 只认可本地 ASR；`cloud_allowed` 可认可本地或云端 ASR。
- WAV 上传与 Worker 重核均使用同一规则；Provider 失效后的 Worker 不调用 ASR Gateway。
- 页面显示转写阶段；错误响应和任务错误不包含密钥、原始音频正文、Blob URI、主机路径或 Provider 原始响应。
- 类型、回归、构建与 E2E 门禁通过。
