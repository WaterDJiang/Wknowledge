# 媒体学习位置事件 M6-05/M6-12 Spec v1

## 1. 关联计划

- 工作包：`M6-05`、`M6-12`，依赖 `M4-05/M4-06/M4-08/M4-09`。
- 上游：[固定版本原文学习与事件](learning-original-events-m6-05-m6-12-v1.md)。
- 当前状态：开发中。本切片只记录已确认计划内可播放媒体的当前位置；不宣称媒体学习或真实 Provider 浏览器验收已经完成。

## 2. 目标与范围

- 学习者从已确认课程单元打开音频/视频历史原件时，播放器把当前位置追加为 `progressed` LearningEvent。
- 课程链接只传递计划单元 ID；服务端仍以 active 计划、固定 `sourceRef`、ResourceVersion 和当前空间成员资格重核，URL 参数不授予学习记录权限。
- 普通资料库、Wiki 引用、错题依据和手工打开来源页不写 LearningEvent。
- 只在媒体时间范围内记录位置，最少相隔 15 秒；暂停与定位末尾的有效位置可强制同步。

## 3. 核心规则

- `positionMs` 必须是非负整数，且被限制在该 `audio/video startMs/endMs` SourceLocator 范围。无效或没有范围的定位不发请求。
- 一次播放不会自动写 `completed`，用户仍需在课程页显式标记完成。
- 同步失败仅显示“位置暂未同步”，不阻断播放、不伪造已保存位置，也不重试为无限请求。
- 位置事件不携带媒体正文、Blob URI、服务器路径、模型内容或字幕正文。
- 追加事件使 `GET /api/learning/active` 可以重建 `lastPosition`；刷新课程页后显示的事件数量以服务端聚合结果为准。

## 4. 影响面

- `apps/web/app/workspace/learning/course-outline.tsx`：只为“打开原文”附加计划单元关联参数。
- `apps/web/app/workspace/source/page.tsx`、`source-preview.tsx`：仅在有效关联存在时向媒体播放器提供记录回调。
- `apps/web/app/workspace/media-source-player.tsx`：播放阈值、范围截断、同步状态和暂停/结束处理。
- `POST /api/learning/events` 和 `packages/core` 不放宽现有来源、计划或权限校验。

## 5. 验收

- 课程媒体从固定来源打开后，播放超过 15 秒、暂停或到达定位末尾会追加 `progressed`，其中 `unitId/sourceRef/positionMs` 正确。
- 普通来源预览绝不请求学习事件接口。
- 伪造单元 ID、不同 `sourceRef`、撤权或无 active 计划被现有 API 拒绝，且不留下事件。
- 连续 `timeupdate` 不会造成请求风暴；相同位置或小于 15 秒的推进不重复写入。
- 单元测试覆盖位置截断、去重阈值和强制同步判定；全仓格式、Lint、类型与测试门禁通过。
