# 客观练习确定性评分 M6-08/M6-09 Spec v1

## 1. 目标

- 在既有有来源候选练习上，为 `easy` 难度建立第一种可重复、可审计的客观评分：学习者回到固定原文后，写出受管知识点陈述。
- 每次客观作答形成不可改写的 Attempt 快照和唯一不可改写的 Grade；评分由确定性规则完成，不调用模型、Skill、Embedding 或外部网络。
- `standard`、`challenge` 继续是自由作答并进入 `pending_review`，不把主观理解伪装为自动评分或掌握度。

## 2. 范围

```text
POST /api/learning/practice/{questionId}/attempts
GET  /api/learning/practice
GET  /api/learning/report/active
```

- `easy` 候选题为 `exact_response`，其答案键来自同一固定 Course KnowledgePoint 的 `statement`。
- 题目表保存受管 `answer_key`；Attempt 提交时复制为 `answer_key` 快照。两者均不得出现在公共 Zod 契约、API 响应、LearningEvent 或浏览器页面。
- 提交客观题时，在同一数据库事务中追加 Attempt、Grade、`practice.attempt_submitted` 与 `practice.attempt_graded` 事件；Attempt 原始作答、题面和答案键不被后续题目或知识更新改写。
- 当前进展报告增加客观已评分、答对、得分和满分的确定性指标；不生成掌握度、错题结论、排名、模型解释或 PNG/PDF。

## 3. 核心规则

- 客观判定固定为 `exact_response.v1`：对作答和 Attempt 答案键执行 Unicode NFKC、首尾去空白、连续空白折叠和 Unicode 小写后比较；相等得 `1/1`，否则 `0/1`。
- Grade 只引用 Attempt 快照而非当前题目答案键；答案键、题目、来源资料重命名或新版本上传不能重算、覆盖或改变历史 Grade。
- 每个 Attempt 最多一个 Grade。客观 Attempt 成功创建时必须已有 Grade，公共契约呈现为 `graded`；Grade 是已判定的事实来源。自由作答 Attempt 没有 Grade，状态固定为 `pending_review`。
- 客观题的答案键只来自系统已经固定并带 SourceLocator 的知识点陈述，不接受浏览器、模型、Skill 或请求体提供标准答案。
- 创建和提交仍重核当前课程归属和空间成员资格。撤权后保留历史 Attempt/Grade，但拒绝新的作答与评分。
- 所有 Grade 与来源只能服务本人当前 Course 的报告聚合；不得泄露其他用户、旧 Course 或答案键。

## 4. 验收

- 完成单元后生成 `easy` 候选，返回 `answerType: exact_response`，但任何 API/页面 JSON 均不含答案键或知识点原文陈述的隐藏字段。
- 同一语义答案仅发生 NFKC、空白或大小写差异时稳定得 `1/1`；其他答案稳定得 `0/1`；多次提交保留独立 Attempt/Grade 历史。
- `standard`/`challenge` 仍返回 `free_response` 且提交后无 Grade、保持 `pending_review`。
- Attempt、Grade、提交/评分事件在同一事务写入；失败不留下半成品 Grade 或错误状态。
- 刷新后报告能从数据库重建客观作答、正确数、得分与满分；资料改名、题目版本变动或撤权均不改写历史指标。
- 自动化覆盖答案键不泄露、跨用户/撤权拒绝、归一化比较、评分重放与报告聚合；全仓质量门禁通过。

## 5. 后置

- 单选、多选、数值、公式等其他客观题型与 `objective-grade` Skill 的 Sandbox 执行。
- 人工裁决、主观量表建议分、低置信度复核、错题和掌握度快照。
- 正式 Assessment 发布、报告解释与 Worker 生成 PNG/PDF Artifact。
