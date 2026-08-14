# ASR 时间戳分段 M4-05 Spec v1

## 1. 关联计划

- 工作包：`M4-05`，前置受管 `speech_to_text` Provider、WAV 准入、媒体探测与不可变 ResourceVersion。
- 状态：开发中。

## 2. 目标

- 让兼容 OpenAI 的 ASR Provider 可以返回 `verbose_json` 的时间分段，并将每个有效分段写为独立、可回源的 `transcript` 节点。
- 保持兼容性：Provider 仅返回纯文本时保留一个明确标记的整段媒体节点，不能伪造分段、说话人或词级精度。

## 3. 范围与规则

- Worker 请求 `response_format=verbose_json`；Gateway 接受字符串或 `{ text, segments }` 响应，验证分段的秒级边界和文本上限。
- 每个分段必须满足 `0 ≤ startMs < endMs ≤ 媒体时长`，按开始时间排序；无效、重叠或空分段整体降级为完整媒体转写，不写部分错误证据。
- 分段节点保留同一 ResourceVersion 的 `audio startMs/endMs`，元数据明确标注 `provider_segments`；回退节点标注 `whole_media_provider_without_timestamps`。
- ASR 输入仍只来自 Worker 受管 Blob；Provider 选择、位置和空间数据策略不变。响应正文不进入模型审计或错误消息。

## 4. 验收

- Gateway 对 `verbose_json` 返回结构化文本与合法分段；Worker 生成连续、可定位的 transcript 节点。
- 纯文本/无分段响应仍生成一个全媒体节点且显式降级；无效分段不得产生错误时间定位。
- 空间策略、健康/启用重核、审计脱敏、取消、类型、回归与构建不退化。

## 5. 不包含

- 词级时间戳、说话人分离、音轨抽取、视频 ASR、字幕、关键帧或视觉模型。
