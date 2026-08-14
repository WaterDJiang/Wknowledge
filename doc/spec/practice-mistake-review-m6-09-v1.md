# 可回查错题回顾 M6-09 Spec v1

## 1. 目标

- 为当前 active Course 提供只读的“当前待回顾客观题”清单，帮助学习者从最近一次确定性判错回到固定原文与同一候选题再次练习。
- 错题事实只来自本人 Attempt 的不可变 Grade；不以模型推断、题目当前答案键或资料最新版本改写历史判断。
- 本切片不产生掌握度、时间衰减、排名、学习诊断或自动计划调整。

## 2. 范围

```text
GET /api/learning/review/mistakes
```

- 返回当前用户、当前 active Course 的错题清单。
- 每个 `practiceQuestionId` 最多一个条目：选取该题最近一次已有 Grade 的 Attempt；只有其 `correct: false` 时才显示。
- 条目仅含 Attempt 已固定的题面、本人作答、课程/知识点/版本身份、`wk://source/...` 与 Grade 摘要；不返回答案键、原文正文、其他用户 Attempt 或主观题状态。
- 学习页在进展报告后显示错题回顾，可打开原文依据或定位回候选题重新作答。

## 3. 核心规则

- 仅从当前 Course 的 `candidate` PracticeSet、当前用户 Attempt 和独立 Grade 查询；历史 Course、其他用户、未评分自由作答均排除。
- 同题后续提交正确答案会从当前错题回顾移除；此前错误 Attempt/Grade 和学习事件保持不可变。
- 不重新计算 Grade，不读取题目/Attempt 的受管 `answer_key`，不调用模型、Skill、Embedding 或网络。
- 当前空间授权用于来源打开时由既有 SourceLocator 读取链路再次校验；回顾列表不复制原始文件或 Wiki 正文。
- 无 active Plan/Course 时返回既有学习域缺失错误，未登录返回 `401`。

## 4. 验收

- 错误客观作答出现一次且包含固定题面、本人作答、Grade 和来源定位；答案键不出现在响应或页面数据中。
- 同题再次答对后清单移除；不同题的错误彼此独立。
- 标准/进阶自由作答、其他用户、旧课程和无 Grade 作答不进入清单。
- 资料改名或新版本上传不改变条目的 ResourceVersion、SourceLocator、题面、作答或 Grade。
- 自动化覆盖当前结果选择、答案键隔离、课程/用户边界和 API 未登录门禁。

## 5. 后置

- 错题集合版本、错误原因分类、人工复核结果、掌握度快照和时间衰减。
- 基于已确认错题的 `practice-generate` Skill、正式测评、学习报告 PNG/PDF。
