# ASR Provider 能力 M5-08/M4-05 Spec v1

## 1. 关联计划

- 工作包：`M5-08 模型 Provider 路由`、`M4-05 音频 ASR`。
- 前置：空间 `dataPolicy`、受管 Provider 密钥加密、模型健康检查、M4-07 本地媒体探测与 Worker 受控 LocalBlob 路径。
- 当前状态：开发中。本切片只建立可管理、可审计的 `speech_to_text` Provider；不改变媒体上传 MIME 准入，也不创建转写任务。

## 2. 目标与范围

- Provider 能力显式声明为 `chat` / `speech_to_text`；设置页、路由和后续 Worker 使用同一契约。
- OpenAI-compatible ASR 使用服务端 `/audio/transcriptions` multipart 调用，密钥、超时、模型名和文件请求不暴露给浏览器。
- Gateway 在调用前执行能力、健康状态与空间数据策略选择：`local_only` 与尚未实现媒体脱敏的 `cloud_allowed_after_redaction` 都不得发送媒体给云端。
- 本期不包含媒体上传、转写任务、字幕、说话人、关键帧、视频理解、厂商 SDK、Embedding 或向量检索。

## 3. 安全与验收

- Provider 至少一个能力；能力声明不等于已开放上传。
- ASR 输入只接受 Worker 创建的 `Blob`、安全文件名、可选语言/提示词；拒绝 URL、主机路径和浏览器 Provider 参数。
- Gateway 按启用、健康、能力、空间策略选择；无可用 Provider 返回 `MODEL_CAPABILITY_UNAVAILABLE`，不得隐式降级为云端或聊天模型。
- `/audio/transcriptions` 使用 multipart，包含 model/file 和 `response_format=verbose_json`，不附带聊天 JSON 格式；响应必须有非空 text。合法 Provider 分段保留，其他响应统一降级为完整媒体节点；错误统一为稳定 `MODEL_*` 且不含密钥、路径或 Provider 原文。
- WAV、MP3、M4A 直传及分片上传在空间存在健康、启用且策略相容的 ASR Provider 时可进入实际 M4-05 Worker；未满足条件时路由返回 `ASR_PROVIDER_REQUIRED`，不创建处理任务。准入继续校验扩展名、MIME 与 WAV/MP3/M4A 容器签名，其他音频格式仍关闭。
- Worker ASR 先接收 M4-07 已验证的媒体探测输出；只对 `audio` locator 的同一不可变 ResourceVersion 创建 `transcript` 节点。Provider 分段必须有序、非重叠且位于媒体时长内；无细粒度时间戳或分段无效时必须显式标记为全媒体单段，不能伪造分段精度。
- 正式 Worker 只读取同组织中启用、健康且声明 `speech_to_text` 的 Provider；执行后记录不含正文/媒体字节的 `resource.asr.completed` 审计事件（Provider、模型、耗时）。

## 4. 后续

- M4-05：Worker 基于 M4-07 探测结果构造受管 LocalBlob ASR 输入，写 transcript 节点、manifest、checkpoint 与运行审计。
- M4-09：以真实音频 ResourceVersion 验收播放器定位和转写引用。
