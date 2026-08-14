# 受管 Provider 学习生成 Skill M5/M6 Spec v1

## 1. 关联计划

- 工作包：`M5-06/M5-07/M5-08`、`M6-03/M6-06`。
- 上游：[Plan-compose 候选计划落库](plan-compose-candidate-materialization-m6-03-v1.md)、[Practice-generate 候选练习受控落库](practice-generate-candidate-materialization-m6-06-v1.md)、[模型 Provider](model-provider-management-m5-08-v1.md)。
- 状态：`plan-compose` 与 `practice-generate` Worker 纵向切片均已开发，并通过本地/云端脱敏集成测试；真实 Provider 运维验收与已登录浏览器闭环仍后置。第三方 CLI Skill 继续不获得模型/网络权限。

## 2. 决策

动态 CLI Sandbox 继续禁止 `requiredCapabilities`、模型调用和网络。`plan-compose`、`practice-generate` 的真实模型调用改由 **Worker 内置 learning-generation handler** 完成：

```text
学习页面显式选材/已完成课程单元
→ 受控 LearningGenerationRequest（仅结构化最小输入）
→ SkillRun + Policy/Approval/Outbox
→ Worker 重核 Binding、成员、课程/来源、模型策略
→ 受管 Provider Gateway（chat）
→ 固定 JSON Schema
→ 受限 candidate 产物
→ 既有领域物化/用户确认
```

- Pi、OpenCode、Claude Code 不进入该调用链；它们只继续提供 Adapter、Skill/权限、Hook UX 的参考边界。
- 模型密钥只能由 Worker 从加密 Provider 配置解密后使用，绝不传入动态 CLI、Skill 输入文件、前端、审计或候选 API。

## 3. 输入与隐私

### 3.1 `plan-compose`

- 页面提交：目标、显式 ResourceVersion 选择、学习者 declared 快照。
- Worker 输入：已授权资料的稳定 ID、名称、MIME、编译模式、受限来源定位和允许提供给模型的结构摘要；不传 Blob URI、宿主路径、原始文件或其他用户数据。
- 输出：既有 `PlanComposeCandidateOutput`。每个 Unit 必须指向用户选择版本与合法 SourceLocator，随后仍由领域物化重新验证。

### 3.2 `practice-generate`

- 页面提交：已完成 CourseUnit 选择与难度；历史 Attempt 仅传本人脱敏统计，不能传答案正文、答案键、Grade 细节或其他学习者记录。
- Worker 输入：固定 CourseUnit、KnowledgePoint、ResourceVersion、SourceLocator 与受限学习重点；只允许当前 active Course 的精确 Binding。
- 输出：既有 `PracticeGenerateCandidateOutput`。Worker 与物化层均重核 course Binding、完成事件、题型、量表、来源和资料版本。

### 3.3 数据策略

- `local_only`：只允许 `location=local`、健康且启用的 chat Provider。
- `cloud_allowed`：可使用本地或云端健康 Provider。
- `cloud_allowed_after_redaction`：云端仅接收去标识化后的目标、标题、结构摘要和来源 ID；不得接收原始正文、文件名、用户说明、答案/作答或直接标识符。
- 一个请求涉及多个空间时取最严格策略；无可用 Provider 以稳定失败码结束且不发送请求。

## 4. 运行、审批与审计

- 每个生成请求以 `LearningGenerationRequest` 与一个 `SkillRun` 一对一保存。输入正文只存受限请求记录；`SkillRun.inputSummary`、输出摘要和审计只写计数、模式、Provider ID/model、耗时、成本（若 Provider 返回）及稳定错误码。
- 请求创建和 Worker 认领都重核 Skill version/digest、组织启停、会话 Binding、成员资格、数据策略、Provider enabled/health/capability 与预算。
- `approval=always` 的生成 Skill 必须先批准；批准快照不含目标、题面、正文或答案键。撤权、过期批准、课程切换、Provider 停用、超时或 Schema 失败不得留下 candidate。
- 固定系统提示把资料摘要、转写、Wiki/原文摘录和用户说明全部标注为不可信数据；其中的操作指令不能改变权限、工具、Provider、范围、网络或输出 Schema。

## 5. 前端

- 内容选择页提供“用 Skill 生成个性化候选”与确定性草稿的并列入口；请求仅返回 Run 并由 Worker 处理，候选出现前不创建计划。Provider 不可用、策略不相容或运行失败时 Run 以稳定失败码结束，页面保留确定性草稿入口。
- 练习页只允许已完成单元发起“生成针对性练习候选”；候选卡明确标记 AI 候选、Skill/模型版本和来源，不展示答案键。
- 生成请求只返回 `jobId`/`skillRunId`；页面通过既有运行状态和 SSE 读取阶段，不能轮询或读取候选正文来推断模型输入。

## 6. 验收

- 无 Provider、错误能力、未健康/停用 Provider、策略不相容、预算不足、撤权或审批失效均不发模型请求、不写 candidate。
- `local_only` 不会调用云端；redaction 策略的云端请求不含原始正文、文件名、用户说明、答案键或作答。
- Worker 发出的每个模型请求能追溯 Provider/model、SkillRun/version/digest、数据策略、Binding 数与耗时，但审计不含提示词/回复正文。
- 合法 Run 只能得到既有受限候选产物；模型不能直接写 active Plan、Course、Assessment、Attempt、Grade、掌握度或报告。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e` 通过；另有 mock Provider 与真实本地 Provider 的独立 Worker E2E。

## 7. 非范围

- 动态 CLI 的模型/网络开放、浏览器上传第三方 Skill、Pi/OpenCode/Claude Code 生产依赖。
- 自动发布正式测评、主观自动最终评分、掌握度推断、向量检索或 Embedding 调用。
