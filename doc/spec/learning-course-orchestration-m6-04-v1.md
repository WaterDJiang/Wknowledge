# 学习课程编排 M6-04 Spec v1

## 1. 目标

- 已确认的 `LearningPlan` 必须生成一份不可变、可浏览的 `Course`；课程把已选择的固定资料版本整理为模块、学习单元和最小知识点。
- 第一版使用确定性编排，不调用模型或 `plan-compose` Skill；课程结构必须忠实映射计划快照，不能把 AI 推断伪装成资料事实。
- 课程单元继续使用原计划的 `ResourceVersion` 和 `wk://source/...`，原文阅读、学习事件与后续练习均可回查同一证据。

## 2. 范围

```text
POST /api/learning/plans/{planId}/confirm
GET  /api/learning/course/active
```

- 确认计划的同一事务创建一个 active Course、单一“原文学习”模块、按计划顺序排列的 CourseUnit，以及每单元一个来源锚定的 KnowledgePoint。
- 知识点在本切片只是稳定的课程内标识、标题、说明和来源，不声称已完成 LLM 知识拆分；M6-06 的练习必须以后续确认的知识点/来源契约为准。
- 不增加课程编辑器、AI 编排、视频进度、练习、测评、评分、掌握度或报告生成。

## 3. 核心规则

- Course、Module、Unit 与 KnowledgePoint 都只属于确认时的 `LearningPlan`；计划归档、资料改名、重新编译或新增资料版本不得改写已生成结构。
- 同一计划最多有一个 Course；confirm 重试必须幂等，不得重复创建课程。
- 创建 Course 前重做计划确认已有的资料版本和空间成员授权检查；失败时不产生 active Course。
- 升级回填只处理每个单元均有 `sourceRef` 且其固定 `ResourceVersion` 仍存在的 active 计划；不完整历史计划不得伪造来源，学习页必须提示重新生成计划。
- `CourseUnit.resourceVersionId`、`CourseUnit.sourceRef` 与 `LearningPlanUnit` 必须完全一致；所有来源引用均为平台受管 `wk://`，不存 Blob URI 或本地路径。
- 学习者只能读取自己的 active Course；撤销空间权限后保留课程历史，但原文读取和新增学习事件仍由 M6-05 的权限检查拒绝。

## 4. 验收

- 确认计划后可读取 active Course，模块/单元/知识点顺序和数量与计划快照一致。
- 单元和知识点均能回溯到同一 `ResourceVersion` 与 `SourceLocator`；课程内容不含原文件正文。
- 同一计划的 confirm 重试、读取和历史资料改名均不产生重复或覆盖。
- 无 active Course、非本人、无权计划或不合法来源不会返回课程数据。
- 本切片的自动化证明模型、Embedding 与 SkillRun 调用数均为 0。
