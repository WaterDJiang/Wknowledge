# 可追溯练习作答入库 M6-08 Spec v1

## 1. 目标

- 学习者能对本人当前 active Course 的候选自由作答题提交练习答案；每次提交形成不可改写的 Attempt。
- Attempt 固定题目、题目版本、量表、CourseUnit、KnowledgePoint、ResourceVersion 与 `wk://source/...`，使后续审核、评分和报告可回查当时证据。
- 初始自由作答题没有经审核的标准答案，因此为 `pending_review`；后续 M6-08/M6-09 为受管 `exact_response` 候选新增独立 Grade 记录，详见 `objective-practice-grading-m6-08-m6-09-v1.md`。两类作答均不调用模型、Skill、Embedding 或外部网络。

## 2. 范围

```text
POST /api/learning/practice/{questionId}/attempts
GET  /api/learning/practice
```

- POST 接受 1–4,000 字符的 `response`，同一题允许多次提交，历史 Attempt 不覆盖、不删除。
- GET 在当前 active Course 的本人候选练习中返回题目下的作答历史与复核状态，不返回其他用户 Attempt。
- 学习页面在候选题下提供答案输入、提交、已保存状态、待人工复核提示和原文依据跳转。

## 3. 核心规则

- 只能向本人、当前 active Course、`candidate` PracticeSet 内的题目提交。伪造题目 ID、其他用户题目、旧课程题目均拒绝。
- 提交前重新验证 ResourceVersion 所属知识空间成员资格；撤权后保留历史 Attempt，但拒绝新作答。
- Attempt 保存题目版本、提示、量表和所有来源字段的快照；资料重命名、新版本上传、候选题未来版本或知识更新不得改写历史 Attempt。
- 提交与 `practice.attempt_submitted` LearningEvent 在同一事务追加；事件只保存 Attempt 身份、题目版本和来源，不保存作答全文。
- 不提供编辑、删除、人工裁决、模型建议分、错题、掌握度、正式测评或报告。确定性评分必须新建 Grade 记录，不能改写 Attempt 原始答案；主观 Review 继续后置。

## 4. 验收

- 已完成学习单元生成的候选题可提交多个答案；刷新后按时间看到每次答案、题目版本和来源快照。
- 提交后资料改名或生成新资源版本，历史 Attempt 的来源和题目快照不变。
- 未登录、跨用户、非当前课程、撤权、空白/超长答案均被拒绝；拒绝不产生 Attempt 或 LearningEvent。
- 自动化证明作答提交没有模型、Embedding、SkillRun 或外部网络调用，且不写入任何分数或掌握度字段。
