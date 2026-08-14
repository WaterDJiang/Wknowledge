# 可追溯练习候选 M6-06 Spec v1

## 1. 目标

- 学习者只能针对当前 active Course 中已经完成的学习单元生成练习候选；候选固定 CourseUnit、KnowledgePoint、ResourceVersion 和 `wk://source/...`。
- 第一版以确定性“原文复述”模板生成候选，明确标记为候选题，不调用模型、Embedding、SkillRun 或外部网络；后续 M6-08/M6-09 已将 `easy` 收敛为受管答案键的 `exact_response`，详见 `objective-practice-grading-m6-08-m6-09-v1.md`。
- 为后续 `practice-generate` Skill、正式题目审核、作答/评分和报告提供不可变题目版本与来源锚点，不提前声称已完成测评。

## 2. 范围

```text
GET  /api/learning/practice
POST /api/learning/practice
```

- POST 接受已完成 CourseUnit 的受管 ID 和难度 `easy/standard/challenge`，生成一个 `candidate` PracticeSet；`standard/challenge` 为自由作答，`easy` 为受管答案键的客观回顾候选。
- 学习页面默认预选所有已完成单元，但学习者可取消或仅选择本次想复盘的单元；提交的仍是 CourseUnit 受管 ID，客户端不能指定原文、知识点、路径或答案。
- 候选题提示学习者回到固定原文并说明要点；题目保存来源、资料版本、评分量表占位和版本 `1`，不保存原文正文或 Blob URI。
- 不实现模型生成、题目审核/发布、主观评分、掌握度、错题或正式报告；`easy` 的确定性 Grade 属于后续 M6-08/M6-09 范围。

## 3. 核心规则

- 只能读取或生成本人的当前 active Course 候选；没有 active 课程、选中非当前课程单元、重复单元或未完成单元一律拒绝。
- 创建时重新验证每个固定 ResourceVersion 的空间成员资格；撤权后不能生成新候选，既有候选和历史计划不被改写。
- 每题必须同时关联 CourseUnit、KnowledgePoint、ResourceVersion 与 SourceLocator；缺任一证据不创建候选。
- `candidate` 不是正式题目或测评；不得用于掌握度、成绩、报告或学习状态推断。
- `practice-generate` 接入时只能创建同一候选契约，必须另存 SkillRun/version/digest；不得覆盖确定性候选或绕过后续审核。

## 4. 验收

- 只完成 `opened` 而未 `completed` 的单元不能生成候选；完成后可获得有来源的候选题。
- 候选题、量表说明、资料版本和来源在资料改名、新版本上传或重新编译后不变。
- 非本人、撤权、非 active Course、伪造/重复 CourseUnit ID 均不能创建或读取候选。
- 自动化证明本切片没有 Model Provider、Embedding、SkillRun 或外部网络调用。
- 页面清楚显示当前已选择的练习范围；未选择任何已完成单元时不请求 API。
