# 学习报告快照与导出产物 M6-13 Spec v1

## 1. 目标

- 将当前 active LearningPlan/Course 的确定性 `LearningProgressReport` 固化为不可改写的 `LearningReportSnapshot`，再由 Worker 生成同一快照的 PNG 与 PDF Artifact。
- 报告 JSON 是指标事实来源；网页预览、PNG、PDF 都只展示该 JSON，不能重新聚合、调用模型或生成额外学习结论。
- 用户只可读取自己的快照与产物；快照创建后，后续学习事件、资料新版本、题目与作答变化不改写历史报告。

## 2. 范围

```text
POST /api/learning/report/active/snapshots
GET  /api/learning/report/active
GET  /api/learning/report/snapshots
GET  /api/learning/report/snapshots/{snapshotId}
GET  /api/learning/report/snapshots/{snapshotId}/artifacts/{format}

learning_report_snapshot
learning_report_outbox
learning.report.render
```

- 控制面仅创建快照并写 Outbox；PNG/PDF 只在 `apps/worker` 的 `learning.report.render` 队列生成。
- Artifact 使用受管 BlobStore 不可变键保存，数据库仅保存 URI、SHA-256、字节数和状态；不放入 Markdown Wiki、原始资料目录或浏览器本地存储。
- 首期输出为简洁、确定性的中文报告：计划/课程 ID、生成时间、单元完成、练习/作答、客观成绩、待复核、可回查作答与知识点评分证据汇总。它不展示回答正文、答案键、知识点标题、`sourceRef`、其他用户数据、模型输入/输出、学习推断或真实宿主路径。

## 3. 核心规则

- 创建时必须重新解析当前用户 active Plan/Course；没有 active Course 返回 404。快照的 `report` 必须通过 `learningProgressReportSchema` 校验，且 `learningPlanId/courseId` 与记录字段一致。
- 同一用户的同一 Course 同时最多一个 `queued/rendering` 快照；重复点击返回这一进行中快照，不重复投递。
- Worker 认领时重核快照为 queued、用户/Plan/Course 存在、报告结构有效；渲染完成后原子写入两个 Artifact 元数据并标记 completed。失败只保存稳定错误码和脱敏摘要，可由用户显式重新创建快照。
- 产物读取再次按 `snapshot.userId` 鉴权；完成前返回 409，格式不在 `png/pdf` 返回 400，不存在/他人快照按未找到处理。
- 若队列投递失败，Outbox 保留 pending；Worker 定时重试投递。Worker 重启后可重新发送 pending/过期 dispatching Outbox。
- 历史列表只返回当前用户自己的快照，按创建时间倒序、最多 20 条；选择历史快照后，网页指标、状态和下载入口都必须来自该快照的固定 `report`/Artifact，不能以当前 active Course 实时数据替代。
- “最新导出快照”只驱动导出状态和文件下载；它不自动替换当前实时学习指标。只有用户主动选择历史项、或没有当前实时报告时，网页指标才切换为冻结快照。
- 正在查看历史快照时，导出区只允许下载该历史快照自己的已完成 Artifact，不显示“为当前进展生成报告”操作；存在实时报告时可显式返回当前进展视图。

## 4. 验收

- 完成学习、作答后创建快照：快照 JSON 与创建瞬间的实时报告一致；之后再完成学习或提交作答，旧快照指标不变。
- Worker 生成真实 PNG 与 PDF，两个 Artifact 的内容均包含同一个快照指标；其 SHA-256、字节数和 Blob URI 可追溯，但 API 不暴露内部 URI。
- 重复创建不重复排队；失败、队列中断和 Worker 重启可以安全重试；未登录、越权、无 active Course、未完成 Artifact 均正确拒绝。
- 不调用模型、Skill、Embedding、Wiki 查询、外部网络；全量迁移、单元/集成、API E2E、格式、Lint、类型和构建通过。

## 5. 后置

- 分享/外发审批、主观评分解释、长期掌握度图表、品牌化模板、多页明细和报告 Skill。
