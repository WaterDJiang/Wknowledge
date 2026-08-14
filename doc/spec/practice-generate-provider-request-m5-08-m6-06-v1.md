# Practice-generate 受管 Provider 请求 M5-08/M6-06 Spec v1

## 1. 关联计划

- 工作包：`M5-06/M5-07/M5-08`、`M6-06`。
- 上游：[受管 Provider 学习生成 Skill](provider-backed-learning-skills-m5-m6-v1.md)、[候选练习受控落库](practice-generate-candidate-materialization-m6-06-v1.md)。
- 状态：开发中。私有请求、精确 Course Binding、内置 Provider Worker、候选暂存与一次性确认已接通；真实 Provider 运维验收与已登录浏览器闭环仍后置。动态 CLI 不开放模型或网络。

## 2. 请求边界

```text
当前 active Course
→ 已完成 CourseUnit 的显式选择 + 难度
→ 精确 course Binding 的临时 AgentSession
→ SkillRun + LearningGenerationRequest + Outbox
→ 后续 Worker 重核并生成受限候选
```

- 只可选择当前学习者 active Course 中已完成的 CourseUnit；重复、未完成、课程外或无权 Unit 不创建任何 Session、Run、请求或 Outbox。
- Session 仅含当前 Course 的 `course` Binding；资料范围由 Course 的不可变 Unit 快照解析，不能改为空间或手工路径。
- 私有请求保存 Unit ID、难度；Run 摘要和审计只保存单元数量与难度，不能保存题面、答案、量表、目标、正文或来源 URI。
- 后续模型输入仅包含已完成 Unit、KnowledgePoint、固定资源版本、来源和受限摘要；云端脱敏不得接收原文、文件名、答案键、作答或其他学习者数据。
- 每个显式选择的 CourseUnit 至少必须在输出中有一道题；模型不能遗漏选择单元、以未选 Unit 替换，或用一题覆盖多个 Unit。

## 3. 验收

- 合法请求产生一个精确 Course Binding、私有请求和 queued Run；Run 与请求/Outbox 同事务创建。
- 未完成或课程外 Unit 被拒绝且无半成品。
- 后续 Worker 只能读取对应 Run 的私有请求，并逐题重核当前 Course/Unit/KnowledgePoint/来源。
- 模型遗漏任一显式选择的 Unit 时，Worker 以稳定候选无效错误失败，且不创建候选产物。
- mock local Provider 只能为已完成 Unit 写入来源绑定候选，Run 摘要不保存题面正文；`cloud_allowed_after_redaction` 请求不含课程标题、学习目标、资料名称或 KnowledgePoint 原文。
