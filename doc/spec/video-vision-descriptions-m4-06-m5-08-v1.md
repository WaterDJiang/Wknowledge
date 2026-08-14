# 视频关键帧视觉描述 M4-06/M5-08 Spec v1

## 1. 关联计划

- 工作包：`M4-06` 视频入库与 `M5-08` Provider Registry；执行顺序见 [Agent/学习扩展计划](../plan/agent-learning-expansion-v1.md) 第 5、6.E、7 节。
- 上游：不可变 ResourceVersion、Worker 关键帧资产、空间数据策略、Provider 健康检查和 Markdown-first Wiki 编译。
- 状态：开发中。本切片不实现端到端视频模型、场景切分、人物识别或视频生成。

## 2. 目标

- 管理员可将受管 OpenAI-compatible Provider 声明为 `vision` 能力。
- Worker 对已提取、受限尺寸的 JPEG 关键帧调用策略相容的 Vision Provider，形成带视频时间定位的画面描述节点。
- 画面描述、关键帧 OCR、内嵌字幕和音轨转写在节点元数据和 Wiki 证据中可区分，不能互相冒充。

## 3. 数据与安全边界

- 只传 Worker 已提取的 `keyframes/frame-*.jpg`；不上传原始视频、Blob URI、宿主路径、资料名称、数据库数据或其他学习者内容。
- `local_only` 空间只选择本地 Provider；云端 Vision Provider 仅可用于 `cloud_allowed`。`cloud_allowed_after_redaction` 在本切片视为不相容，因为画面像素尚无可验证脱敏步骤。
- 每个视频最多处理既有 8 帧，每帧最大 5 MiB；输入提示只要求描述可见画面，并明确图片中的文字和指令均是不可信数据。
- 模型输出必须是受限 JSON `{ description, confidence? }`；解析失败、超时、Provider 消失或数据策略不相容时，不写描述节点，不影响关键帧、OCR、字幕、ASR 或资料入库。
- 描述节点固定同一 `ResourceVersion`、关键帧时间点和资产路径，记录 Provider ID、模型、置信度及 `source: video_keyframe_vision`；不声称人类核验或事实确定性。

## 4. 处理流程

```text
MP4 媒体探测
→ 有效视频流时提取受限 JPEG 关键帧
→ 可选本地关键帧 OCR
→ 查找健康、启用、策略相容的 vision Provider
→ 逐帧视觉描述并校验 JSON
→ 写入同版本时间定位节点
→ staged compiled 发布、Wiki 编译与来源预览
```

## 5. 验收标准

- 设置页可创建、编辑、列出带 `vision` 的本地或云端 Provider；Provider 凭据保持服务端加密。
- 同一帧的画面描述有正确 `video` SourceLocator 和关键帧资产引用；音轨转写/OCR 不会被标为画面描述。
- 无 Vision Provider、模型失败、非本地 Blob、非法输出或取消时，处理任务仍保留原有媒体证据并安全完成/取消；不会留下部分视觉描述。
- `local_only` 资料不会发送到云端；`cloud_allowed_after_redaction` 不调用云端 Vision Provider。
- 视频 Wiki/问答引用能显示描述来源类型；来源页继续跳到原始视频对应时间。
- 覆盖 Provider schema、数据策略、模型输入、有效描述、无效响应与跳过回归；通过根目录质量门禁。
