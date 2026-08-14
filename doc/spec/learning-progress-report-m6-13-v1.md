# 可回查学习进展报告 M6-13 Spec v1

## 1. 目标

- 为当前 active LearningPlan/Course 提供只读、确定性的学习进展报告数据：原文学习完成度、候选练习题数、作答数、待人工复核数、有来源作答数、已判定客观题表现，以及按知识点投影的当前评分证据表现。
- 报告所有指标都从 LearningPlan/Course、追加 LearningEvent、PracticeSet/Question/Attempt 重建；不由模型猜测成绩、掌握度、耗时或结论。
- 基础报告实时聚合当前 active Course；导出扩展将同一结构固化为不可变快照，并由 Worker 渲染 PNG/PDF。仅有 Grade 的客观题显示得分，待复核作答不显示为得分。

## 2. 范围

```text
GET /api/learning/report/active
```

- 返回当前用户 active Course 的 `LearningProgressReport`；没有 active 计划/课程返回 `404`。
- 学习页显示“学习进展报告”分区，展示课程单元完成率、练习候选/题目/作答/待复核数量和所有作答可回到来源的比例。

## 3. 核心规则

- 只汇总本人当前 active Course；不得因同组织、同空间或历史 Course 泄露他人或旧计划的学习数据。
- 学习完成数从当前 active Plan 的追加 LearningEvent 重建；练习数从该 Course 的 `candidate` PracticeSet 与其题目/Attempt 计算。
- `pending_review` 不是已评分、已通过或掌握；仅 Grade 可进入知识点评分证据投影。该投影只显示稳定知识点 ID、最近评分、当前满分数和平均得分，不返回排名、长期掌握结论、错因或自然语言诊断。
- 每个 Attempt 都由数据库快照携带 SourceLocator；报告只将拥有非空 `wk://source/...` 与 ResourceVersion 的 Attempt 计为“可回查”。
- 数据策略、模型、Skill、Embedding 和网络调用均不参与该报告；未来 `learning-report-explain` 只能解释已存在的报告数据。

## 4. 验收

- 完成单元、创建候选、提交作答后，报告数值正确变化；刷新可从数据库重建相同指标。
- 改名资料或创建新版本不改变已提交 Attempt 的可回查计数。
- 未登录、无 active Plan/Course、跨用户访问均拒绝，不泄露聚合值。
- 自动化覆盖零数据、部分完成、多次作答、来源快照及撤权后的报告读取边界。

## 5. 后置

- 长期掌握度、学习建议、分享/外发审批和模型解释。
- 报告快照与 PNG/PDF 的具体契约、权限与 Worker 渲染规则见 [学习报告快照与导出产物 M6-13 Spec](learning-report-artifacts-m6-13-v1.md)。
