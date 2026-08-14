# 确定性知识点表现快照 M6-11 Spec v1

## 1. 关联计划

- 工作包：`M6-08`、`M6-11`、`M6-13`，接续已冻结的 Practice/Assessment Attempt、确定性评分与报告快照。
- 上游：[客观练习评分](objective-practice-grading-m6-08-m6-09-v1.md)、[自由作答人工复核](manual-free-response-review-m6-08-v1.md)、[可回查学习进展报告](learning-progress-report-m6-13-v1.md)。
- 状态：开发中。本切片只建立有确定性评分或人工评分依据的知识点表现快照；不调用模型、不推断知识、能力或学习建议。

## 2. 目标

- 每次 Practice 或 Assessment Grade 完成时，为对应的用户、课程知识点和不可变 Attempt/Grade 创建一条 `mastery_snapshot` 证据记录。
- 当前 active Course 的报告按知识点读取最近一条本课程评分快照，呈现“已评分覆盖、当前正确/未正确、最近得分”，而非声称长期掌握度。
- 旧 Snapshot、Attempt、Grade、题面、来源和报告导出均保持不可改写；后来重做、人工评分或资料更新只能产生新 Snapshot。

## 3. 数据与计算

```text
objective grade | human review grade
→ deterministic evidence snapshot
→ mastery_snapshot
→ active Course 的每知识点最近记录
→ LearningProgressReport.mastery
→ 报告快照 / Web 指标
```

`mastery_snapshot.evidence` 必须仅包含：

- `schemaVersion: 1`、`courseId`、`courseUnitId`、`knowledgePointId`；
- `attemptType`（`practice` 或 `assessment`）、`attemptId`、`gradeId`；
- `grader`、`ruleVersion`、`score`、`maximumScore`、`correct`；
- 固定 `resourceVersionId` 与 `sourceRef`。

不保存回答正文、答案键、评分理由、模型输入/输出、真实文件路径或其他学习者数据。`score` 固定为 `score / maximumScore`，范围 `[0,1]`。

## 4. 核心规则

- 只有当前 Course 内、存在 Grade 且来源快照完整的 Attempt 可创建 Snapshot；待复核不计入覆盖或分数。
- 对客观题，Snapshot 与 Grade/Attempt/学习事件在同一事务中写入。对人工评分，Snapshot 与 Review Grade、学习事件和审计事件在同一事务中写入。
- 同一个 Attempt 只能创建一条 Snapshot；唯一索引保护重复提交/并发人工复核。
- 报告只查询当前用户当前 active Course 的知识点；按 `createdAt`、`id` 选取每个知识点的最近 Snapshot。历史 Course、他人、未评分 Attempt 和撤权后的新写入均不能混入。
- `mastery` 是“当前证据表现”，不是 AI 推断、预测、能力等级或通过结论。用户可在课程、题目和作答记录中回到对应的固定 `SourceLocator` 复查依据。
- 报告 JSON 和导出快照只含知识点稳定 ID 与评分指标，不含原文名称、`sourceRef`、题面、作答或评分理由；创建后历史报告不因新 Snapshot 改写。

## 5. API/UI 范围

- 不新增写入 API；现有作答和人工复核 Route 触发内部 Snapshot。
- `GET /api/learning/report/active` 的 `mastery` 字段包括已评分知识点数、课程知识点数、当前满分数、平均得分百分比和每知识点受限摘要。
- 学习报告页明确标记“当前评分证据表现”；没有 Grade 时显示“暂无评分证据”，不显示 0 分或“未掌握”。原文回查入口保留在课程、题目和作答记录中。

## 6. 验收

- 正确/错误的客观 Practice 与单次 Assessment 都产生独立 Snapshot；人工复核也产生 Snapshot；未评分自由作答不产生。
- 同一知识点多次作答保留全部 Snapshot，报告只使用当前 Course 最近一条，且正确率/平均分可重建。
- Snapshot 的证据不含回答、答案键、rationale、模型字段或真实路径；资料改名/新版本不改写已有 Snapshot。
- 不同用户和旧 Course 的 Snapshot 不影响当前报告；报告快照在后续作答后保持原值。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 通过。

## 7. 明确后置

- 模型主观评分、置信度、诊断、遗忘曲线、长期掌握模型和自动调整计划。
- 未经独立审核的生成型题目、AI 建议分和学习建议。
