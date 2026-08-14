# Practice-generate 候选练习受控落库 M6-06 Spec v1

## 1. 关联计划

- 工作包：`M6-06`，依赖 `M5-06/M5-07` 已完成的动态 SkillRun 和 `M6-04/M6-05` 的当前课程、完成事件与固定来源。
- 上游：[可追溯练习候选](practice-candidates-m6-06-v1.md)、[学习应用设计](../design/learning-application-v1.md)。
- 状态：开发中。本切片只接收合格的结构化 `practice-generate` 输出为受限候选，再由领域服务物化为日常 candidate PracticeSet；不安装 Skill、不调用模型、不替代既有确定性模板题。

## 2. 目标

- 将 `practice-generate` 的结构化输出与 SkillRun 一对一保存为仅本人可见的候选产物；通用 Run 摘要和审计不得保存题面、答案键、量表或来源正文。
- 只有当前 active Course、已完成 CourseUnit、对应 KnowledgePoint、固定 ResourceVersion 与一致 SourceLocator 均重新验证后，才创建 `PracticeSet(status=candidate, generation=skill_candidate)`。
- 生成型 Skill 只能提出新候选，不能发布测评、改写既有题目、创建 Attempt/Grade、更新掌握度或报告。

## 3. 输入与写入边界

```text
已完成且属于当前学习者的 practice-generate SkillRun
+ 当前 active Course 的精确 course Binding
+ Skill 输出的题面 / 题型 / 答案或量表 / KnowledgePoint / SourceLocator
→ 领域重核
→ PracticeSet(status=candidate, generation=skill_candidate)
→ 日常练习或独立正式测评确认
```

- Run 必须有当前 active Course 的精确 `course` Binding；空间、页面或单个资料 Binding 不能推断为“已学课程”权限。
- 每题仅能引用当前课程中已完成的 CourseUnit，且 KnowledgePoint、ResourceVersion、SourceLocator 必须与该 Unit 的固定快照完全一致。
- `exact_response` 必须有受限答案键及对应量表；`free_response` 不得携带答案键，必须有可复核量表。候选 API 不返回答案键。
- 同一个候选产物至多物化一个 PracticeSet；并发提交、已物化候选、撤权、课程切换、Run 终态变化或来源不一致均不得创建题集。

## 4. 非范围

- 不执行或安装真实 `practice-generate`，不放开模型、网络、原始 Blob 或动态 Skill 管理 UI。
- 不改动确定性模板练习、正式测评、客观评分、人工复核、掌握度或报告算法。
- 不向 Skill 暴露答案键、其他学习者记录、未完成单元或整空间正文。

## 5. 验收

- 合格已完成 Run 只能形成受限候选；无效输出使 Run 失败且不留下候选产物。
- 只有带当前 Course Binding 的本人 Run 才可物化，且题目逐一匹配已完成 Unit、KnowledgePoint、资源版本与来源。
- 伪造答案类型/量表、重复知识点、未完成单元、课程外题目、来源错配、撤权和重复物化均不创建 PracticeSet。
- 物化后的题集保存 `SkillRun` version/digest 追溯；题面/答案和量表不写入通用摘要、审计或浏览器公开 API。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e` 通过。
