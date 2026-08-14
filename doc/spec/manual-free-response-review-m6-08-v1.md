# 自由作答人工复核 M6-08 Spec v1

## 1. 关联计划

- 工作包：`M6-08`，依赖 M6-06 候选题、M6-07 正式题卷、不可变 Attempt 与 SourceLocator。
- 状态：已验证。本切片只提供组织管理员对本人组织内自由作答的人工评分；不调用 `rubric-grade`、不生成 AI 评分建议、不计算掌握度或改写学习计划。

## 2. 目标

- 让 `free_response` 的 `pending_review` 作答有可审计、可回查的人工评分出口。
- 评分只能附加到既有 Attempt，不能修改题面、回答、量表、答案键、来源、资源版本或历史客观 Grade。
- 正式测评与日常候选练习共用同一受控评分规则，但对外仍按各自题卷/练习入口呈现。

## 3. 范围与状态

```text
free_response Attempt pending_review
→ organization owner/admin 读取受权复核队列
→ 依据冻结 rubric + SourceLocator 给分和简短依据
→ immutable human_review Grade
→ Attempt graded
```

- 仅 `owner`、`admin` 可以查看或提交本组织的待复核作答；学习者和其他组织成员不可枚举。
- Score 必须为 `0..maximumScore` 的整数，`maximumScore` 必须等于冻结量表；`rationale` 为 1–1,000 字，不能包含模型/提示词或外部结论。
- 每个 Attempt 最多一个 Grade；客观题已有 `objective_rule` Grade，不能被人工接口覆盖。并发提交必须返回稳定冲突，不产生第二条 Grade。
- 当前来源访问被撤销时，管理员仍可读取冻结 Attempt 与 sourceRef，但来源预览继续受现有权限控制；评分不再读取原文或当前 Wiki。

## 4. API 与页面

```text
GET  /api/learning/reviews/free-response
POST /api/learning/reviews/free-response/{attemptId}
```

- 队列只返回冻结的题面、量表、作答、来源入口、课程/知识点、状态和已有 Grade；不返回答案键、其他组织数据、原始 Blob URI 或模型内容。
- 系统设置新增“人工复核”入口，仅对组织管理员显示；页面明确提示评分依据是固定题面和量表，来源链接另开受权预览。
- 写操作经登录、同源、限流、组织角色重核，评分与审计/学习事件同一事务落库。

## 5. 验收标准

- 管理员仅能查看/评分自己组织中 `free_response + pending_review` 的 PracticeAttempt 和 AssessmentAttempt；学习者、跨组织管理员、客观题、已评分项均被拒绝。
- 一次评分生成不可变 Grade、`graded` 状态、学习事件和组织审计；分数、量表最大分、来源与审查者可追溯。
- 重复/并发评分不会覆盖已有 Grade 或创建第二条 Grade。
- 题面、回答、来源和答案键不会被评分 API 改写或回显；不调用模型、Skill、Embedding 或外网。
- 已通过迁移、领域/API 回归及根质量门禁；真实管理员点击流因无安全可复用登录会话而另行记录。

## 6. 明确后置

- `rubric-grade` Skill、模型建议分、置信度、二次复核、申诉和评分量表编辑。
- 组织级题库发布、跨学习者测评、掌握度和报告解释。
