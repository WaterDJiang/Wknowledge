# Agent、Skill 与学习闭环产品化 Spec v1

## 1. 关联计划

- 工作包：`M5-00` 至 `M5-12`、`M6-01` 至 `M6-13`，以及媒体前置 `M4-05/M4-06/M4-08/M4-09`。
- 执行顺序：[Agent 对话与学习闭环扩展计划](../plan/agent-learning-expansion-v1.md) 第 5–10 节。
- 当前状态：计划已收敛，产品化开发中。现有多轮会话、受管 Binding、`knowledge.search/read` 审计、固定原文、确定性练习/评分与报告是可复用基础；真实模型对话、生成型学习 Skill、Linux Sandbox 实测和完整已登录端到端流程尚未验收。

## 2. 目标

- 将知识问答交付为“类似 Codex/Claude 的受管对话工作台”，而不是检索结果页。
- 让用户选择有权限的知识空间、Wiki 页面、资料版本或课程，作为本轮 Agent/Skill 的显式上下文，并呈现平台虚拟路径。
- 将学习交付为“选材 → 计划候选 → 确认 → 固定原文 → 针对性练习 → 入库评分 → 可回查报告图片”的闭环。
- 复用 Pi、OpenCode、Claude Code 的已审查模式，但不嵌入高权限 Coding Agent。

## 3. 范围与非范围

### 3.1 对话工作台

- 会话支持新建、恢复、重命名、归档、停止/继续和有限历史上下文。
- 会话上下文支持 1–8 个 Binding：`space`、`wiki_page`、`resource_version`、`course`。
- 页面显示服务端生成的 `/knowledge/{spaceId}/...` 只读虚拟路径、授权状态与 Scope 标签。
- 每轮固定执行“重新授权 → `knowledge.search` → 必要时 `knowledge.read` → EvidenceBundle → 自然语言回答 → 来源区”。
- Skill 仅经摘要发现和 Policy 处理：`allow` 可排队、`ask` 必须批准、`deny` 不向 Agent 暴露；运行历史记录版本、digest、Binding、审批和脱敏摘要。

### 3.2 学习闭环

- 学习者先选择具体资料、Wiki 页面或课程范围并提交目标；选材生成不可变版本快照。
- `plan-compose` 仅产出带 SourceLocator 的 `draft`，由用户确认后再创建 active 计划、Course、Unit 与知识点映射。
- 学习单元始终打开确认时的 ResourceVersion 原文。文本/PDF/Office/图片复用当前来源预览；音视频仅在转写、字幕、时间定位和播放器验收完成后启用。
- `practice-generate` / `assessment-generate` 仅输出候选题；题目必须具备 KnowledgePoint、SourceLocator、题目版本及答案键或量表。
- Attempt、Grade、Review 与 LearningEvent 追加入库；客观题由确定性规则评分，主观题的模型建议分只能进入人工复核。
- `LearningReport` JSON 是报告事实来源；Worker 使用同一 JSON 输出 Web、PNG、PDF，模型解释单独标识为 AI 推断。

### 3.3 明确不在本切片范围

- 将宿主机路径、Blob URI、数据库 URI 或用户上传文本中的路径交给 Agent/Skill。
- 通用 Shell、Git、代码编辑、任意网络访问或无人批准的动态 Skill。
- 让模型直接写 active 计划、正式题卷、Attempt、最终 Grade 或报告指标。
- 将 Pi、OpenCode 或 Claude Code 的本地会话/配置/权限文件作为业务真相源。

## 4. 核心安全与数据规则

- 上传资料和转写文本均是不可信数据，不能改变 Tool、Skill、权限或 Scope。
- Binding 在每次 Agent Run、ToolCall 与 SkillRun 前重新进行空间授权；撤权后仅保留脱敏历史元数据，禁止读取正文。
- `knowledge.search/read` 必须先于模型调用，并在构造 EvidenceBundle 前执行 Scope 过滤；无证据时拒答或标记检索摘要。
- Skill 的输入只传最小 Binding 和允许的结构化摘要，不能隐式读取整空间、原始 Blob、其他学习者记录或答案键。
- 新知识版本不得改写已确认计划、历史题目、作答、评分、报告或原文定位。

## 5. 开源框架采用边界

| 候选/参考     | 可复用模式                                      | 集成位置                              | 禁止事项                                                          | 通过条件与回退                                                                        |
| ------------- | ----------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Pi agent core | 事件、工具循环、取消、上下文裁剪                | `AgentCoreAdapter` 后的可选实现       | 作为 Sandbox、RBAC、存储或密钥真相源                              | 锁定版本/commit、许可证、依赖树/脚本/摘要、20 条合成轨迹和替换测试；失败使用内部 Loop |
| OpenCode      | Skill 摘要发现、按需加载、`allow/ask/deny` 交互 | 自有 `SkillAdapter` / Policy / 设置页 | 读取 `opencode.json` 作为组织权限，嵌入完整 Coding Agent 或 Shell | Manifest/审批/撤权/提示注入反例通过；失败保持自有实现                                 |
| Claude Code   | 工具状态、拒绝优先、审批与 Hook UX              | 自有 UI、Policy 与审计设计对照        | 运行 CLI、账户、外部 Hook 或宿主机命令                            | 只形成公开规范对照；所有执行仍由 Worker Sandbox 完成                                  |

## 6. 首个完整验收场景

```text
学习者创建会话并只绑定一个已授权 Wiki 页面
→ 发起两轮追问，查看 search/read、自然语言答复与独立来源
→ 选择两份内容与学习目标，运行已批准的 plan-compose
→ 确认计划并从固定版本原文完成一个 Unit
→ 运行 practice-generate，完成一道候选客观题和一道需复核主观题
→ 刷新后重建进度与评分状态
→ 打开同一 LearningReport JSON 驱动的 Web、PNG、PDF
```

验收同时覆盖：范围外资料不出现在 ToolCall/EvidenceBundle/引用中；撤权、`..`、伪造路径和未批准 Skill 均被拒绝；每个计划、题目、评分和报告指标可追溯到版本化内容、SourceLocator 或学习事件。

## 7. 影响面

- `packages/contracts`：Binding、ToolCall、Skill 输出、计划候选/题目候选及报告 Schema。
- `packages/core`：授权、EvidenceBundle、计划确认、题目/评分重核和报告聚合。
- `packages/agent-runtime` / `packages/skill-runtime`：Adapter、Policy、Approval、Worker/Sandbox 边界。
- `apps/web`：独立对话、上下文、学习计划、原文、练习、报告路由与状态展示。
- `apps/worker`：受控 Skill、报告渲染、媒体派生与失败恢复。

## 8. 验收门禁

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm test:e2e`
- M5 新增跨空间/撤权/路径穿越/提示注入/Skill 审批/停止恢复 E2E。
- M6 新增计划确认、固定版本原文、题目来源、评分重放和 JSON–PNG/PDF 一致性 E2E。

## 9. 2026-08-14 增量需求：对话 Skill、学习生成与开源采用

### 9.1 对话是受管工作台，不是检索结果页

- `AgentSession` 支持多轮自然语言对话；每轮始终先使用当前 Binding 的 `knowledge.search/read`，再把受控 EvidenceBundle 交给模型。回答、工具状态、Skill 状态和来源资料分区显示。
- 用户可以在会话创建和上下文面板中选择知识空间、Wiki 页面、ResourceVersion 或已确认 Course。系统展示服务端生成的 `/knowledge/{spaceId}/...` 虚拟路径；它不是本机、容器、Blob 或数据库路径。
- 对话 Skill 只以 manifest 摘要参与可发现性，并按 `allow`、`ask`、`deny` 决定可见和执行。`ask` 必须保存批准快照后才进入 Worker；Skill 输入只含必要 Binding/结构化摘要，不能获得整库正文、原始文件、其他学习者记录或答案键。
- 会话每轮重新授权。移除 Binding、成员撤权、`..`、绝对路径、伪造虚拟路径和上传资料中的提示指令都不能扩大读取或执行范围。

### 9.2 学习是受控的内容到报告闭环

- 学习者先选择资料、Wiki 页面或 Course 并填写目标；`plan-compose` 只能输出带 SourceLocator 的计划候选。只有用户确认后，领域服务才创建 active LearningPlan/Course/Unit。
- Unit 只能打开计划快照中的历史 ResourceVersion 原文。文本/PDF/Office/图片复用来源预览；音频/视频必须分别满足转写、字幕、时间定位和播放器验收后才可作为学习单元。
- `practice-generate`、`assessment-generate` 只产出候选题，每题必须关联 KnowledgePoint、SourceLocator、题面/答案或量表版本与 SkillRun。Attempt、Grade、Review 和 LearningEvent 均为不可变记录；Skill 不得直接发布题卷、覆盖作答或写最终分数。
- `LearningReport` JSON 是成绩、时长和完成率的唯一事实来源。Worker 以同一 JSON 渲染 Web/PNG/PDF；若模型提供说明，必须标为 AI 推断且不得计算或覆盖指标。

### 9.3 开源框架的采用规则

| 候选/参考     | 采用位置                                    | 本期允许复用                               | 禁止事项                                                          |
| ------------- | ------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| Pi agent core | `AgentCoreAdapter` 后的可替换候选           | 事件、工具循环、停止、消息转换、上下文裁剪 | 不作为权限、Sandbox、数据库、BlobStore 或密钥真相源               |
| OpenCode      | 自有 `SkillAdapter`/Policy 的交互与语义参考 | Skill 摘要发现、按需加载、`allow/ask/deny` | 不读取 `opencode.json`，不嵌入完整 Coding Agent、Shell 或主机权限 |
| Claude Code   | 自有工具状态、审批和 Hook 生命周期 UX 对照  | 拒绝优先、工具前后状态、失败可见           | 不运行 CLI、账户、Hook 命令或宿主机工具                           |

- 新依赖进入仓库前必须在隔离夹具中完成版本/commit、许可证、依赖树、生命周期脚本、摘要、20 条脚本化轨迹、取消/注入/替换测试审查。
- 任何候选未通过时保留内部 Loop/Adapter；不能因为引入框架而降低 RBAC、SourceLocator、Worker Sandbox 或 Markdown-first 查询约束。

### 9.4 增量验收

- 仅绑定一个页面的两轮对话不读取或引用同空间其他页面；撤权/移除 Binding 后新一轮读取被拒绝，历史审计只保留脱敏元数据。
- `ask` Skill 未批准、`deny` Skill、越界 Scope、非法虚拟路径和提示注入均不能创建有效 SkillRun。
- 从两份已选内容生成计划候选、确认、学习固定原文、作答、评分和报告后，刷新仍可重建同一版本、学习位置和报告指标。
- Pi/OpenCode/Claude Code 的采用记录必须明确“已采用、未安装候选或仅文档参考”，不能把参考框架表述为已经接入的产品能力。
