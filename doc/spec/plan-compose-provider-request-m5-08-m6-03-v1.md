# Plan-compose 受管 Provider 请求 M5-08/M6-03 Spec v1

## 1. 关联计划

- 工作包：`M5-06/M5-07/M5-08`、`M6-03`。
- 上游：[受管 Provider 学习生成 Skill](provider-backed-learning-skills-m5-m6-v1.md)、[Plan-compose 候选落库](plan-compose-candidate-materialization-m6-03-v1.md)。
- 状态：开发中。本切片只建立真实模型生成前的私有请求与可靠排队边界；尚不开放学习页触发或 Provider Worker 调用。

## 2. 目标与范围

`LearningGenerationRequest` 与一个 `SkillRun` 一对一保存。它只承载 `plan-compose` 的私有输入：学习目标和显式选择的 ResourceVersion ID。

```text
显式选材 + 目标
→ 精确 ResourceVersion Binding 的临时 AgentSession
→ SkillRun + LearningGenerationRequest + Outbox 同事务写入
→ 后续 Worker 认领、重核并调用受管 chat Provider
```

- 选择只能是当前用户有权读取且状态为 `ready` 的资料版本；重复 ID、空选择和无权版本必须拒绝。
- 会话只绑定选中的 `resource_version`，不因资料属于某个空间而扩大为整空间。
- `SkillRun.inputSummary`、Outbox 和 Audit 仅保存资料数量及固定操作名，不能包含目标、文件名、正文、路径或来源 URI。
- 私有输入只存在 `learning_generation_request.input`，不在候选 API、运行记录或审计中返回。
- 创建失败时应删除刚创建的临时会话，不能留下可见的半成品 Scope。

## 3. 非范围

- 不调用 Provider、读取原文或生成候选；这些属于下一 Worker handler 切片。
- 不在学习页面显示“生成”按钮，不改变确定性计划草稿入口。
- 不实现 `practice-generate` 的私有请求；它复用相同表结构但将在课程范围/完成单元约束确定后接入。

## 4. 验收

- 合法调用产生一个临时会话、精确 Binding、一个 queued `SkillRun`、一个私有请求和一个 pending Outbox；Run 与请求在同一事务创建。
- `SkillRun` 公共 DTO 与 Audit 不含目标、资料名称或原始内容。
- 无权、非 ready、重复或超过 8 个资料版本的输入不创建任何会话、Run、请求或 Outbox。
- 后续 Worker 只能通过 `skill_run_id` 读取同用户、同会话的一对一私有请求。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 通过。
