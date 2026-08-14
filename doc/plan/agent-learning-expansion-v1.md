# Agent 对话与学习闭环扩展计划 v1

## 1. 目标与适用范围

本计划细化主计划中的 `M5 Agent/Skill/模型` 与 `M6 学习应用`，将产品交付为：

- 类 Codex/Claude 的受管知识对话工作台，而不是检索结果页。
- 用户可显式挂载有权限的知识范围，并在对话中按策略使用 Skill。
- 用户可选择内容、生成并确认学习计划、阅读或播放固定版本原文、练习/测评、记录结果并获得可回查报告图片。
- 以 Pi、OpenCode、Claude Code 的成熟模式完善体验和适配层，但不嵌入高权限 Coding Agent。

本计划不改变项目的基本真相源：PostgreSQL 管状态、权限和学习记录；Markdown Wiki 管知识正文；BlobStore 管不可变原始文件；所有长任务由 Worker 执行。

## 2. 固定产品与安全决策

### 2.1 知识对话的边界

- 对话支持会话、消息、流式回答、工具状态、停止/继续、有限历史和来源区。
- 用户可在会话中选择 `KnowledgeSpace`、`WikiPage`、`ResourceVersion` 或已确认 `Course` 作为 1–8 个 Binding。
- 页面只显示服务端生成的 `/knowledge/{spaceId}/...` 只读虚拟路径；它不是用户电脑、宿主机、容器、Blob 或数据库的真实路径。
- 每轮固定执行：重新授权 → `knowledge.search` → 必要时 `knowledge.read` → EvidenceBundle → 自然语言回答 → 独立来源区。
- 历史消息只帮助理解追问；当前轮 EvidenceBundle 是知识回答的唯一引用依据。无 EvidenceBundle 时只能拒答或明确标记为检索摘要。

### 2.2 Skill 的边界

- Skill 以 manifest 摘要发现，按 `allow`、`ask`、`deny` 决定可见性和执行；`ask` 必须先获得批准。
- 每次运行固定 Skill ID、version、digest、Binding、批准快照、输入/输出摘要和来源。摘要不得含原文、答案键、Blob URI、宿主路径、密钥或子进程日志。
- 对话 Skill 只获得本轮最小必要的 Binding 或结构化输入；不能把历史消息、上传文本或 Skill 输出变成更大的读取范围。
- `plan-compose`、`practice-generate` 等学习 Skill 只从学习页面创建私有请求，不能经通用对话 Skill API 绕过学习范围、确认或候选物化规则。

### 2.3 学习闭环的边界

- 先选择内容及目标，再生成候选计划；未经用户确认不得创建 active `LearningPlan`。
- 学习单元始终打开确认时的 `ResourceVersion` 原文及 `SourceLocator`，新上传版本不能替换历史学习证据。
- 生成型 Skill 只能生成 `draft` 或 `candidate`；`LearningPlan`、正式题卷、Attempt、Grade 和报告事实指标必须由领域服务重核后写入。
- `LearningReport` JSON 是报告唯一事实源；Worker 使用同一 JSON 渲染 Web、PNG、PDF。模型解释必须单独标为 AI 推断，不能自行计算或覆盖成绩、时长、完成率。

## 3. 开源框架采用决策

| 候选/参考     | 本项目位置                                       | 可复用能力                                      | 明确不采用                                                                  | 准入与回退                                                                                          |
| ------------- | ------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Pi agent core | `AgentCoreAdapter` 后的可替换候选                | 工具循环、事件、停止、消息转换、上下文裁剪      | 将 Pi 的会话、默认权限、文件系统或模型配置作为业务真相源                    | 锁定版本/commit、许可证、依赖树、生命周期脚本、摘要、20 条合成轨迹与替换测试通过；否则保留内部 Loop |
| OpenCode      | `SkillAdapter`、Policy 和设置页的模式参考        | Skill 摘要发现、按需加载、`allow/ask/deny` 语义 | 读取 `opencode.json` 作为组织授权，或嵌入完整 Coding Agent、Shell、主机权限 | 用 Wknowledge Manifest、RBAC、审批和审计实现；不通过不阻塞内部执行器                                |
| Claude Code   | 工具状态、审批与 Hook 生命周期 UX 的公开规范参考 | 拒绝优先、工具前后状态、失败可见                | 将 CLI、账户、Hook 命令或宿主机工具嵌入私有化部署                           | 只保留 UX/安全对照记录；由 Wknowledge Policy/Sandbox 强制执行                                       |

所有 Spike 仅使用合成资料、脚本化 Provider 与临时目录；不得读取真实知识正文、生产凭据或宿主机工作目录。第三方代码只能位于 Adapter 后，永远不能拥有数据库、BlobStore、权限、模型密钥或执行环境的最终控制权。

## 4. 目标用户闭环

```text
用户创建会话
→ 选择一个或多个有权限的知识空间/页面/版本/课程范围
→ 查看受管虚拟路径与可用 Skill
→ Agent 在 Binding 内检索、读取并形成 EvidenceBundle
→ 按 Policy 运行或请求批准 Skill
→ 自然语言回答；工具轨迹和来源独立显示

用户选择学习内容与目标
→ plan-compose 生成带来源的计划候选
→ 用户确认版本化计划
→ 打开固定版本文字、PDF、Office、图片或合格音视频原文
→ practice-generate / assessment-generate 生成候选题
→ 作答、确定性评分或人工复核、学习事件入库
→ 由 LearningReport JSON 生成 Web、PNG、PDF 报告
```

## 5. 工作包与交付矩阵

| 优先级 | 工作包                              | 用户可见交付                                                              | 硬约束                                                       | 完成证据                                                          |
| ------ | ----------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| P1     | M5-01/M5-02/M5-10/M5-12             | 多轮对话、会话列表、Binding 面板、虚拟路径、工具状态、停止/继续、来源抽屉 | 不接收真实路径；无 EvidenceBundle 不产生知识回答             | 两轮追问、指定范围不越界、撤权、路径穿越、停止恢复、来源区 E2E    |
| P1     | M5-03 至 M5-07                      | Skill 摘要、`allow/ask/deny`、批准、Worker 执行、脱敏历史                 | 未通过 Sandbox、输出校验、审批和范围重核，不开放生成型 Skill | 未批准/deny/越界/提示注入均不能执行；版本、digest、Binding 可回查 |
| P1     | M5-00                               | Pi Adapter 隔离 Spike；OpenCode 映射；Claude Code UX/Hook 对照            | 不使用生产资料、密钥、网络默认权限或宿主目录                 | 许可证/依赖树/脚本/摘要审查、20 条轨迹、安全反例与内部回退结论    |
| P2     | M6-01 至 M6-04                      | 内容选择、画像/目标、计划候选、确认、Course/Unit 快照                     | 未选内容或无来源的计划不能确认；候选不能直接 active          | 两份内容/目标、候选、确认、刷新后同一版本/结构 E2E                |
| P2     | M4-05/M4-06/M4-08/M4-09/M6-05/M6-12 | 固定版本原文阅读/播放、页码/区域/时间定位、学习事件和位置恢复             | 音视频只在 ASR、字幕、时间定位与播放器验收后开放             | 同一历史版本、页码/区域/时间点恢复；事件可重建进度                |
| P2     | M6-06/M6-07/M6-08/M6-09/M6-11       | 有依据的练习/测评候选、作答、评分、复核、错题与证据快照                   | Skill 不能发布正式题卷、覆盖作答或写最终分数                 | 每题来源、Scope 限制、客观评分重放、主观低置信度复核              |
| P2     | M6-10/M6-13                         | 独立学习入口、结果页、可回查 Web/PNG/PDF 报告                             | 模型不能制造或覆盖事实指标                                   | JSON/Web/PNG/PDF 指标一致；每项可回查事件、Attempt、Grade 或来源  |

## 6. 分阶段详细实施

### A. 开源适配 Spike（M5-00）

交付：

- 同一脚本化 Provider 下的 Pi Adapter 与最小内部 Adapter。
- 流式文本、串行/并行工具、停止、失败、上下文裁剪和事件顺序的 20 条确定性轨迹。
- Pi/OpenCode 的许可证、版本、依赖树、生命周期脚本、更新频率与安全边界审查。
- Claude Code 的公开交互、审批、Hook 和工具状态对照记录。

退出条件：Adapter 替换不修改 `AgentSession`、`ToolCall`、`SkillRun`、`ModelCall` 或学习数据 Schema；任一候选失败均回退内部 Loop，后续功能不被阻塞。

### B. 受管多轮知识对话（M5-01/M5-02/M5-10/M5-12）

交付：

- 创建、重命名、归档、恢复、停止和继续会话；消息、运行、工具调用和证据快照持久化。
- 知识范围选择器按“空间 → Wiki 页面 / ResourceVersion / Course”收窄，显示授权状态和虚拟路径。
- `knowledge.list/search/read`、`source.open`，本轮 Tool/Skill 状态和独立来源区。
- Provider 选择、上下文预算、失败恢复和流式事件；历史只解释意图，当前证据才可引用。

退出条件：刷新后可恢复会话；指定页面外的同关键词资料不进入 ToolCall、EvidenceBundle、模型上下文或引用；撤权后新一轮读取被拒绝，历史只保留脱敏审计与来源快照。

### C. 对话 Skill 与受控运行时（M5-03 至 M5-09/M5-11）

交付：

- Skill 注册、版本、digest、组织启停、Policy、批准、SkillRun、Outbox、运行事件和失败恢复。
- TypeScript/Python CLI 的统一 JSON 输入输出、受控 artifacts、超时、资源限制和稳定错误码。
- Linux fail-closed Sandbox：只读入口/输入、独立可写产物目录、无网络默认值、无原始 Blob/数据库/密钥挂载。
- Provider 能力、健康、数据策略、预算、fallback 与调用审计。

退出条件：无网络 Skill 无法出网；原始文件不可写；超时/超资源/未批准操作被终止；上传资料中的提示注入不能改变权限。动态 Skill 在真实 Linux Sandbox 未通过前必须明确拒绝，不得回退宿主执行。

### D. 选材与计划候选（M6-01 至 M6-04）

交付：

- 资料、Wiki 页面、Course、知识类型和时间范围选择器，以及学习目标和画像输入。
- `plan-compose` 私有请求和带 SourceLocator 的候选；候选、Run、显式版本 Binding、数据策略和审计分层保存。
- 用户确认后由领域服务创建版本化 `LearningPlan`、Course、Module、Unit、KnowledgePoint 和固定来源锚点。

退出条件：无选材、无来源、越权范围或候选覆盖不完整时不得创建 draft/active；修改目标创建新版本，不覆盖历史计划和事件。

### E. 固定原文学习器（M4-05/M4-06/M4-08/M4-09/M6-05/M6-12）

交付：

- 文本、PDF、Office、图片的固定版本阅读、页码/区域/表格/幻灯片定位。
- 通过 M4 准入的音频/视频播放器、字幕、章节、转写和时间点恢复。
- `opened`、`progressed`、`bookmarked`、`completed` 追加式事件；播放不自动等于完成。

退出条件：关闭后恢复同一页码、区域或媒体时间点；所有进度均可从事件重建；音视频定位误差不超过一个转写分段。未配置合格 ASR/媒体能力时，页面显示能力状态，不伪造转写或视频理解。

### F. 针对性练习、测评与评分（M6-06 至 M6-11）

交付：

- `practice-generate`、`assessment-generate`、`objective-grade`、`rubric-grade` 的候选/执行契约。
- 只针对已学范围、固定 KnowledgePoint、SourceLocator、难度与本人历史 Attempt 摘要生成候选。
- 不可改写的 PracticeSet、Assessment、Attempt、Grade、Review、错题和知识点评分证据快照。

退出条件：每题可跳转固定知识依据；客观题重复评分一致；主观题使用量表，低置信度进入人工复核；知识更新不会改变历史题面、答案、作答或评分证据。

### G. 报告和报告图片（M6-10/M6-13）

交付：

- 基于确定性计划、事件、Attempt、Grade 的 `LearningReport` JSON 和不可变快照。
- 独立的学习概览、练习/测评、报告页面，及由 Worker 生成的私有 PNG/PDF Artifact。
- 可选的 `learning-report-explain`，只解释现有指标并记录模型、Skill、置信度与确认状态。

退出条件：JSON、Web、PNG/PDF 核心指标一致；报告不泄露其他用户资料；分享和外发另走授权流程。

## 7. 依赖与执行顺序

```text
M3 可浏览/可引用 Wiki
→ M4 来源预览与相应媒体定位
→ M5-00 Adapter Spike（可与 M3 黄金集准备并行）
→ M5 会话、Binding、Policy、Sandbox、Provider
→ M6 选材/计划/固定原文
→ M6 练习、评分、报告
→ M7 生产验收
```

- M3 正式黄金集未达到门槛时，不能将 Agent 对话检索质量宣称为产品完成。
- M5 Policy/Sandbox 未通过时，不启用第三方或生成型 Skill。
- 文字、PDF、Office 学习可先于音视频推进；视频/音频学习必须等待相应 M4 证明。
- 学习 Skill 必须使用受管 Provider Worker；动态 CLI Sandbox 默认禁止模型和网络，不能作为绕过路径。

## 8. 总体验收场景

```text
学习者创建会话并只绑定一个已授权 Wiki 页面
→ 连续两轮追问，查看 search/read、自然语言回答和独立来源
→ 选择两份内容和学习目标，运行已批准的 plan-compose
→ 确认计划并从固定版本原文完成一个 Unit
→ 运行 practice-generate，确认候选并完成客观题/需复核主观题
→ 刷新后重建进度、评分和媒体位置
→ 打开同一 LearningReport JSON 驱动的 Web、PNG、PDF
```

安全反例必须同时通过：跨空间挂载、撤权后读取、`..`/绝对路径/伪造虚拟路径、未经批准 Skill、恶意上传提示注入、Skill 出网、超时和超资源均被拒绝或停止。

## 9. 明确后置

- 通用 Bash、Git、代码编辑和用户任意挂载服务器目录。
- 多 Agent 自主协作与无审核第三方 Skill 市场。
- 向量数据库和核心 Embedding 检索。
- 自动对外分享学习报告、模型自动决定最终成绩或长期掌握度。
- 将 Claude Code CLI 或其他 Coding Agent 直接作为本项目运行时。

## 10. 当前执行队列与状态规则

1. 先完成 `M7-10-R1/R2/R3`：运行中 Agent 撤权、cloud Provider 固定传输工厂和学习来源授权。它们是对话、真实模型、生成型学习 Skill 的共同安全启用门。
2. 之后完成 `M5-02/M5-10/M5-12` 的真实 Provider、已登录范围控制和来源区验收。
3. 接着完成 `M5-03` 至 `M5-07` 的 Linux Sandbox 实测、审批、越权/出网和产物安全测试。
4. 并行完成 `M5-00` 的合成夹具 Spike；Pi 未经准入不得进入生产依赖，OpenCode/Claude Code 只保持上述边界。
5. 在受控 Skill 前置满足后，完成 `M6-03/M6-04/M6-05/M6-12` 的选材、确认、固定原文和位置恢复已登录流程。
6. 最后接续 `M6-06` 至 `M6-13` 的生成候选、正式测评、评分复核、报告解释和完整 E2E。

已验证的确定性计划、固定原文、候选练习、客观评分和报告快照是后续基础，不得被表述为真实 Provider、完整 Sandbox 或生成型学习闭环已经完成。每个切片完成后更新交付状态、验收记录和当天日志，并执行根目录规定的质量门禁。
