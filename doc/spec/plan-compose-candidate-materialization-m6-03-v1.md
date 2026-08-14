# Plan-compose 候选计划落库 M6-03 Spec v1

## 1. 关联计划

- 工作包：`M6-03`，依赖 `M5-06/M5-07` 的 SkillRun 版本、范围与完成状态快照。
- 上游：[Agent、Skill 与学习闭环产品化](agent-skill-learning-production-enablement-m5-m6-v1.md)、[学习应用设计](../design/learning-application-v1.md)。
- 状态：开发中。本切片实现受限 Worker 将合格结构化输出暂存为候选产物、领域服务再落库，以及学习内容页对既有候选的受权查看/物化入口；不安装 Skill、不调用模型、不开放前端生成触发入口。

## 2. 目标

- 将 `plan-compose` 的结构化输出限定为用户已选择资料上的 **draft**，并保存运行版本、digest 与来源定位。
- 由领域服务重新校验用户权限、SkillRun、Binding、资源版本和每个 Unit 的 `SourceLocator`；Skill 输出不得直接变更 `active` 计划、课程、学习事件或评分。
- Worker 不把候选正文写入 `SkillRun.outputSummary` 或审计事件；仅针对 `plan-compose` 将已通过 Schema 的候选写入独立、所有者受限的候选产物记录。

## 3. 输入与写入边界

```text
已完成且属于当前用户的 plan-compose SkillRun
+ 用户提交的学习目标与 ResourceVersion 选择快照
+ Skill 输出的 title / Unit / SourceLocator
→ 领域重核
→ LearningPlan(status=draft, generation=skill_candidate)
→ 用户 confirm
→ active Plan 与固定 Course/Unit
```

- `selectedResourceVersionIds` 是用户选择快照；候选 Unit 只能引用其中一个版本，且每个选择至少被一个 Unit 覆盖。
- 每个 Unit 的 `sourceRef` 必须能解析为合法 `SourceLocator`，且其中 `resourceVersionId` 与 Unit 字段相同。
- SkillRun 必须为当前用户的已完成 `plan-compose` Run；运行 Binding 只可授权同空间完整 `space`、精确 `resource_version`，或包含该版本的已确认 `course`。页面 Binding 不能被推断为整份资料权限。
- 计划快照保存 `skillRunId`、Skill ID、version 与 digest。Worker 输出正文不写入审计或 SkillRun 摘要。
- 同一个候选产物最多物化为一个 LearningPlan。并发重复提交、已物化候选或被删除 Run 均不得额外创建计划。

## 4. 候选查看与物化界面

- 学习内容页只读取当前学习者已完成 Run 的候选预览，并显示标题、资料版本数、单元与来源；候选正文仍不进入通用 Run 摘要、审计或其他用户页面。
- 用户必须为候选填写本次学习目标，再显式确认候选所覆盖的全部资料版本，才可请求物化。浏览器不得提交自定义来源、Unit、SkillRun、标题或答案。
- 已物化候选显示其已创建的草稿状态，不能再次提交。创建成功后复用既有计划确认流程。

## 5. 非范围

- 不执行或安装 `plan-compose`，不新增模型、网络、Sandbox 权限或 HTTP API。
- 不让候选直接激活计划、不直接创建 Course、题目、Attempt、Grade、报告或学习事件。
- 不读取原始 Blob、整空间正文、其他学习者数据或答案键。

## 6. 验收

- 合法的已完成 Run 与精确 ResourceVersion Binding 只能创建 `draft`；确认前无 active Plan/Course。
- SkillRun 属主/ID/状态、Binding 范围、资源选择、重复 Unit、漏选资料、来源 URI 解析或版本不一致任一失败时不创建计划。
- 非 `plan-compose` 动态 Skill 的输出不进入学习候选产物表；`plan-compose` 输出 Schema 不合法时 Run 失败，且不留下候选产物。
- 候选计划持久化的来源、资料版本和 SkillRun version/digest 在之后资源改名、更新或 Skill 配置变化后不被覆盖。
- 只有所有者能读取候选预览；界面不能替换候选 Unit/来源或绕过每个选中版本必须覆盖的服务端校验。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e` 通过。
