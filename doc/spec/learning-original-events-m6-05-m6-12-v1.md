# 固定版本原文学习与事件 M6-05/M6-12 Spec v1

## 1. 目标

- 用户只能从已确认 active 学习计划的学习单元打开原资料；每个单元保存不可变 `ResourceVersion` 和 `wk://source/...` 定位。
- 原文阅读复用既有来源预览与空间 viewer 授权，不暴露 Blob URI、服务器路径或用户设备路径。
- `opened`、`progressed`、`completed` 作为追加式 LearningEvent 保存，页面可从事件重建当前学习进度。

## 2. 范围

```text
GET  /api/learning/active
POST /api/learning/events
```

- 已处理文字、PDF 和 Office 通过原件预览/下载降级学习；满足 M4-05/M4-06 准入的音频/MP4 复用同一固定 `wk://source` 来源页，以 SourceLocator 的时间范围播放历史原件。转写/字幕仍是独立证据节点，播放器不把它们混写或伪造画面结论。
- 只显示当前 active 计划；历史计划、事件保留但不提供本期历史回放界面。
- 不生成练习、题目、成绩或报告；这些保持 M6-06 至 M6-13。

## 3. 核心规则

- 事件的 `unitId`、`sourceRef` 和 `ResourceVersion` 必须同时匹配当前 active 计划快照。
- 写入事件和读取原件都必须再次验证当前空间成员资格与固定 `ResourceVersion`；确认时必须是 `ready`，但后续同一逻辑资料上传新版本进入处理中不能阻断已确认计划使用其历史版本。撤权后保留既有事件但拒绝新增事件和原文读取。
- 进度由事件确定性聚合：首次 opened 为 `openedAt`、最新 completed 为 `completedAt`、最近带 position 的事件为当前位置。
- 不以页面点击直接判定完成；用户必须明确“标记完成”。
- 媒体播放位置可以作为 `progressed` 的显式 position 保存，但浏览器事件不得自动将任何媒体单元标记为 completed。

## 4. 验收

- 确认计划后，学习页能打开固定历史版本的 `wk://` 原文定位，不接受自填 URL 或路径。
- 同一单元 open/progress/completed 后刷新，事件数、首次打开、完成时刻和最后位置一致。
- 改名、新上传或重新编译资料不改写已确认计划的 sourceRef/版本。
- 非 active 计划、篡改来源、撤权或非 ready 资料新增事件返回可操作错误，不创建事件。
- 音频/MP4 通过固定来源页打开时，播放器跳转到 `audio/video startMs/endMs`；无可用媒体预览时仍提供受权下载，不影响历史计划或来源版本。
