# Agent 对话与学习体验需求 Spec v1

## 1. 关联计划

- 工作包：`M5-00/M5-01/M5-02/M5-03/M5-10/M5-12`、`M6-01/M6-03/M6-04/M6-06/M6-08/M6-10/M6-11/M6-12/M6-13`。
- 详细顺序：[Agent 对话与学习闭环扩展计划](../plan/agent-learning-expansion-v1.md)。
- 当前状态：`M5-00` 已验证；`M5-01/M5-02/M5-10/M5-12` 已交付会话、空间/页面/资料版本/Course 受管范围、请求内 SSE 与停止首切片，`knowledge.search/read` ToolCall 审计和跨进程重放仍待 M5-10/M5-11；`M5-04/M5-05` 已完成策略和审批首切片。用户已批准并启动 `M6-01/M6-03/M6-05/M6-12` 的确定性选材、计划确认、固定原文和学习事件切片；生成型 Skill、Sandbox、正式测评与报告图片仍受各自前置门禁约束。

## 2. 用户问题

- 当前知识问答已有多轮会话、SSE 和受管范围，但尚未持久化类 Codex/Claude 的 `knowledge.search/read` ToolCall 审计、按需读取和跨进程事件重放。
- 知识空间只能由页面当前选择隐式决定，不能在会话中显式添加一个或多个知识库作为上下文。
- 当前学习页已形成“选择内容 → 计划确认 → 固定原文 → 记录 → 候选练习 → 作答/基础客观 Grade → 当前错题/确定性指标”的闭环切片；生成型练习 Skill、正式测评、主观评分、掌握度和 PNG/PDF 报告仍未开始，不能展示为已可用能力。
- Agent 与学习能力需要利用开源框架降低重复开发，但不能继承 Coding Agent 的高权限默认值。

## 3. 目标

### 3.1 Agent 对话

- 用户可以创建、恢复、重命名和归档多轮对话。
- 用户可以为会话添加一个或多个已授权知识库，并看到受管虚拟路径与当前范围。
- 每个上下文绑定必须明确是整个知识空间、指定 Wiki 页面、指定 ResourceVersion，还是课程/学习范围；不能以“当前页面”或模型自行猜测的范围代替。
- 对话可以按需发现和运行 Skill，显示调用状态、批准、产物和错误。
- 回答先使用绑定范围内的 `knowledge.search/read` 构造 EvidenceBundle，再由模型生成自然语言答复；来源资料以独立引用区显示，不把检索结果伪装成对话答案。
- 用户可以在会话创建或设置中直接添加、移除和查看知识范围；界面显示的是受管虚拟路径，不显示或接受宿主机绝对路径。

### 3.2 知识学习

- 用户选择具体资料、Wiki 页面或课程范围后生成学习计划候选。
- 用户确认后进入按模块/单元组织的原文阅读与播放。
- 练习 Skill 根据已学范围、难度和历史结果生成有来源题目。
- 作答、评分、反馈和进度进入数据库，可生成 Web 报告及 PNG/PDF Artifact。
- 学习计划、练习生成与报告解释可作为受控 Skill 运行，但学习进度、客观题分数和报告指标必须由确定性领域服务持久化与计算。

### 3.4 后续执行门禁

- `knowledge.search/read` 必须以 server-owned Binding 为输入，记录脱敏 ToolCall 审计，先于模型调用执行；不得让模型、Skill 或上传资料扩大检索范围。
- `practice-generate` 必须经过 `approval`、`SkillRun`、Worker/Sandbox、Schema 校验与领域重核；产物只可创建新的 AI `candidate` 题集。
- 正式测评、主观评分、掌握度、PNG/PDF 报告均不得绕开固定版本、SourceLocator 与确定性领域记录。

### 3.3 首个用户闭环

```text
创建会话并绑定已授权知识范围
→ 对话通过 knowledge.search/read 和可选 Skill 给出有据自然语言回答
→ 选择资料/Wiki 页面/课程范围与学习目标
→ 生成并确认学习计划
→ 在固定版本原文学习并记录事件
→ 生成针对性练习、提交作答和评分
→ 生成可回查报告页面与 PNG/PDF Artifact
```

本闭环中的“路径”始终是虚拟路径，不是浏览器本地文件路径、服务器路径或容器挂载路径。

## 4. 核心规则

- 知识路径只能是 `/knowledge/{spaceId}/...` 平台虚拟路径；禁止任意绝对路径、`..` 和宿主目录。
- 上下文绑定不复制知识正文到数据库，只保存空间、对象范围、状态和权限快照；每轮运行按绑定清单读取所需页面，不将整个知识库塞入模型上下文。
- 每次 Agent Run 和工具调用重新授权，不能因为会话历史绕过撤权。
- Skill 默认按需加载；`ask` 未批准不执行，`deny` 不向模型暴露完整能力。
- 原文、Wiki 摘要、模型回答和练习反馈使用不同视觉层级与数据字段。
- 计划必须经用户确认；历史题目、作答、评分和报告绑定当时版本。
- 报告指标用确定性聚合计算；模型只能生成有标记的解释和建议。
- 视频/音频学习进度使用已授权的媒体时间点与转写分段；缺少 M4 ASR/视频节点时不得伪造播放器定位或已学习状态。
- 对话回复、Skill 产物、原文、题目、评分与报告分别记录其来源与产生方式；前端不得把检索摘要、模型内容或 AI 候选题伪装为人工审核过的知识、答案或正式测评。
- 对话上下文默认最小授权：创建会话不自动绑定组织全部空间，新增整个知识空间、运行 `ask` Skill、发送正文到云模型和导出报告均须经过相应的策略或批准。

## 5. 开源采用边界

- Pi 的 `@mariozechner/pi-agent-core` 是 M5-00 的首个可嵌入运行时候选；进入依赖前执行 M5-00 Spike。
- OpenCode 是开源 Skill/权限和会话交互模式的参考；首期不嵌入其完整 Coding Agent 服务，而是以 Wknowledge `SkillAdapter` 重现经验证的按需发现和 `allow/ask/deny` 语义。
- Claude Code 只借鉴官方公开的 Skills、Hooks、权限和会话设计，不作为开源 CLI 依赖。
- 所有第三方能力置于 Wknowledge Adapter 后；权限、数据库、Markdown Wiki 和审计保持本项目实现。

### 5.1 M5-00 准入记录

- 每个候选保留来源 URL、commit/tag、许可证、依赖树、安装生命周期脚本、校验摘要和替换测试结果。
- 以同一脚本化 Provider 跑通 AgentLoop、`knowledge.search/read`、`skill.load/run`、停止、重试和事件序列；不得用真实知识正文或生产密钥作为 Spike 夹具。
- 只有通过工具轨迹、权限拒绝、上下文裁剪、撤权和提示注入测试的能力才可进入后续 M5 实现；失败时回退内部 Loop，不改变领域契约。

## 6. 影响面

- `packages/contracts`：会话、消息、上下文绑定、工具事件、学习内容、题目、报告。
- `packages/agent-runtime`：可替换 Agent core、上下文管理、工具循环和事件流。
- `packages/skill-runtime`：按需发现、权限、审批和运行。
- `packages/core/database`：AgentSession、学习与报告领域服务和迁移。
- `apps/web`：对话工作区、内容选择器、学习器、练习与报告页面。
- `apps/worker`：长 Skill、题目批量生成和报告图片渲染。

## 7. 关键契约

### 7.1 会话知识绑定

```ts
interface AgentContextBinding {
  id: string;
  sessionId: string;
  spaceId: string;
  scope: "space" | "wiki_page" | "resource_version" | "course";
  targetId?: string;
  virtualPath: string; // /knowledge/{spaceId}/...
  label: string;
  createdBy: string;
  status: "active" | "removed" | "revoked";
  permissionSnapshot: { role: string; checkedAt: string };
}
```

- `virtualPath` 只由服务端生成和解析；请求中传入的 `..`、绝对路径、符号链接语义或不匹配 `spaceId` 一律拒绝。
- `targetId` 必须属于 `spaceId`，并且会话每轮和工具调用前都重新授权。
- `removed` 与 `revoked` 仅阻断未来读取；历史 `EvidenceSnapshot` 不被改写。

### 7.2 学习计划与练习证据

```ts
interface LearningContentSelection {
  spaceId: string;
  resourceVersionIds: string[];
  wikiPageIds: string[];
  courseIds: string[];
  locators: SourceLocator[];
}

interface PracticeEvidence {
  questionVersionId: string;
  knowledgePointIds: string[];
  sourceLocators: SourceLocator[];
  generatorSkill: { id: string; version: string; digest: string };
}
```

- 计划候选和题目候选没有可用 `SourceLocator` 时不能确认或发布。
- `LearningContentSelection` 与用户目标共同成为 `plan-compose` 的受控输入摘要；正文按需读取，不写入学习业务表。
- `Attempt`、`Grade` 和 `LearningReport` 固化题目/计划/资源版本。报告图片只能由报告 JSON 渲染，不能直接由模型生成。

## 8. 总体验收标准

- 一个用户可在同一会话挂载两个有权知识空间，完成多轮对话和 Skill 调用；回答只引用绑定范围。
- 会话绑定指定 Wiki 页面或 ResourceVersion 时，`knowledge.search/read` 和模型证据均不能越出该对象范围；移除绑定后下一轮立即失效。
- 另一用户或撤权后的用户无法挂载、搜索或读取该空间。
- 会话停止、刷新和恢复后消息、工具状态和历史引用一致。
- 用户从至少两种内容类型生成并确认计划，完成一个学习单元并恢复原文进度。
- 针对性练习的每道题都能打开知识依据；作答和评分可重放。
- 同一学习报告的 JSON、Web、PNG/PDF 核心指标一致且可回查。
- 文档提示注入、Skill 越权、路径穿越和跨空间读取安全测试全部通过。

附加验收：

- 会话 UI 能显示本轮绑定的知识范围、已运行/待批准 Skill 与来源，但不会在聊天正文中泄露模型密钥、宿主路径或未授权资料标题。
- 计划 Skill 输出只创建 `draft`；用户确认后才创建 `active` 计划版本。
- 每个练习题、作答、评分和报告指标均能关联到同一用户、计划版本和知识证据；客观题评分可重复得到相同结果。
- Worker 生成的 PNG/PDF 与 LearningReport JSON 的完成率、题数、得分和时间范围一致。

## 9. 增量实施验收切片

为避免只完成一个对话输入框或一个题目生成按钮，本需求按以下切片验收：

| 切片                | 关联工作包                          | 用户可见闭环                                                         | 必须拒绝/降级的情况                                                          |
| ------------------- | ----------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A：会话与上下文     | M5-01/M5-02/M5-10/M5-12             | 创建会话、选择空间/页面/版本、查看虚拟路径、发送多轮消息、停止并恢复 | 空路径只能做无知识通用对话；任意 host path、`..`、无权空间与撤权空间一律拒绝 |
| B：有据工具与 Skill | M5-03 至 M5-07                      | 看到工具过程、按需加载 Skill、审批并查看输出/来源                    | 无证据拒答；deny Skill 不可发现；ask 未批准不可执行；上传文本不能扩大权限    |
| C：选材与计划       | M6-01 至 M6-04/M6-11                | 选材、填目标、获得候选、调整并确认计划                               | 无选择快照/来源的候选不可确认；Skill 不能直接创建 active 计划                |
| D：原文与练习       | M4-08/M4-09/M6-05/M6-06/M6-08/M6-12 | 打开固定版本原文、记录进度、生成练习、作答、查看评分依据             | 未支持的媒体类型显示能力状态；无来源题目不发布；主观低置信度必须复核         |
| E：报告             | M6-09/M6-13                         | 查看可回查 Web 报告并下载 PNG/PDF                                    | 不能以模型文本直接生成事实指标；未授权用户不能读取/导出报告                  |

### 9.1 对话工作台最低 UI 标准

- 页面包含会话导航、当前消息流、可见的运行/工具状态和可展开的本轮来源；这些区域不能仅存在于隐藏调试面板。
- 当前绑定范围持续显示标题和 `/knowledge/{spaceId}/...` 虚拟路径，且可在运行前编辑；不会显示源 Blob URI、服务器目录或用户设备路径。
- 每次助手输出显示模型/Skill 使用状态和来源数量；只有检索摘要时必须明确标记，不伪装为模型综合答案。

### 9.2 学习闭环最低 UI 标准

- 学习主页只显示继续学习、计划和结果概览；选材、确认、原文、作答和报告分别进入独立路由。
- 原文页以原始内容为主，Wiki/Agent 辅导和练习入口从视觉与数据层面区分；来源定位可打开而不改写原文。
- 结果页显示题目版本、依据、评分状态、复核入口和下一步学习建议；报告图片导出在 Worker Job 完成后才可用。

## 10. 不在本需求范围

- 通用代码编辑、Shell、Git 和任意主机文件访问。
- 多 Agent 自主协作。
- 无审核第三方 Skill 市场。
- 自动外发学习报告。
- 向量数据库或 Embedding 驱动的核心检索。

## 11. 本轮优化确认

- 对话中的“指定路径”必须由已选择知识空间/页面/资源版本生成受管虚拟路径；用户不能输入服务器、本机或 Blob 的真实路径。
- 对话结果先给出基于证据的自然语言答复，来源资料作为单独可打开的引用区；不能把原始命中列表当成问答答案。
- 学习必须经过“选择内容 → 计划候选 → 用户确认 → 固定版本原文 → 有依据练习 → 记录/报告”链路；任一步缺少来源、确认或版本锚点时不得伪造完成。
- Pi、OpenCode 和 Claude Code 的采用分别限于 Agent core 候选、Skill/权限模式参考和公开 UX/安全规范参考；三者都不能绕开 Wknowledge 的权限、审计、SourceLocator 与数据真相源。

## 12. 2026-08-14 实施增补

### 12.1 对话的完成定义

- 知识问答完成必须同时具备：可恢复会话、显式范围选择、服务端生成的知识虚拟路径、按需 Tool/Skill 状态、自然语言回答和独立来源区。
- 当前 `workspace/query` 可以作为快速入口，但不能取代对话工作台；命中列表只能作为无模型/证据不足时清楚标记的降级结果。
- 每次模型或 Skill 运行均固定 Binding、Policy、Skill digest、模型版本和 EvidenceBundle 来源；刷新、停止、撤权和失败不能扩大后续读取范围。

### 12.2 学习的完成定义

- 学习计划始终从用户显式选择的内容和目标开始，并固定 ResourceVersion/Wiki 页面/SourceLocator；更新资料只能创建新计划版本，不能改写历史学习或测评证据。
- 原文学习页面以历史原件为主；媒体在可用时记录时间位置，但不以播放事件自动判定完成。练习页面只展示具有知识点和来源的 candidate/正式题目，并清楚区分两者。
- `practice-generate`、`assessment-generate`、`rubric-grade` 在 Sandbox、审批和 Worker 通过前不得连接真实模型或直接改变计划、分数、掌握度和报告指标。

### 12.3 开源实现守则

- Pi 通过可替换 `AgentCoreAdapter` 试验；OpenCode 通过自有 Skill/Policy 实现借鉴其交互语义；Claude Code 只作公开 UX/Hook 对照。
- 任何上游接入先完成版本、许可证、依赖脚本、摘要、安全轨迹和撤除回退验证；失败时保持内部运行时，不降低数据、权限或审计约束。

## 13. Skill 驱动对话与学习闭环增补

### 13.1 目标与范围

- 关联工作包：`M5-01/M5-02/M5-03/M5-04/M5-05/M5-06/M5-07/M5-10/M5-12`、`M6-03/M6-06/M6-07/M6-08/M6-11/M6-13`。
- 知识问答必须是可恢复的 Agent 对话：用户显式选择知识范围，平台将其映射为 Binding 与虚拟路径；模型先经 `knowledge.search/read` 获得证据，再回答，Skill 作为受控工具按需运行。
- 学习必须形成“选材、候选计划、用户确认、固定原文、候选题、作答/评分、报告”的可追溯闭环；媒体学习以来源定位和已验收播放器能力为前提。
- Pi、OpenCode、Claude Code 只可通过 `AgentCoreAdapter`、`SkillAdapter` 和 UX/安全对照进入；它们不得取代 PostgreSQL、Markdown Wiki、RBAC、SourceLocator、BlobStore、审计或学习记录。

### 13.2 不可替代行为

- 上下文选择器只提交稳定领域对象的 ID 和 scope；虚拟路径、可读取内容及模型上下文均由服务端解析。任何真实路径、URI、`..`、符号链接语义或上传文本指令都不能进入 Tool/Skill 输入。
- 每个 SkillRun 固定 manifest version/digest、审批、Binding、受控输入摘要、输出摘要和来源。`allow` 可入 Worker 队列，`ask` 必须先审批，`deny` 不在模型可见列表中。
- `plan-compose`、`practice-generate`、`assessment-generate` 和 `rubric-grade` 在完整 Sandbox/Worker/Schema 门禁前只能显示能力状态；即使接入后也只能生成 draft/candidate/建议，不能直接激活计划、发布测评、改变 Grade、掌握度或报告指标。
- 模型生成内容、原文内容、评分事实和报告指标在 UI/API/存储中必须分层。回答来源、题目依据和报告指标均可回查到 EvidenceBundle 或 SourceLocator/领域事件。

### 13.3 验收标准

- 只绑定一页 Wiki 后，连续追问及 Skill 运行不能检索、读取、引用或摘要同空间其他页面和其他空间内容；撤权、删除 Binding、伪造路径和未批准 Skill 全部拒绝。
- 学习者从显式内容选择生成并确认计划，原文学习与媒体位置均固定历史版本；知识库更新不能改写已有 Unit、Attempt、Grade、Report 或 Artifact。
- 生成题缺少 KnowledgePoint、可解析 SourceLocator、答案/量表版本或 Skill 追溯时不创建 candidate；客观题重放一致，低置信度主观建议进入人工复核。
- Web、PNG、PDF 使用同一 LearningReport JSON 的指标；模型解释另有标记且不能与确定性指标混淆。

## 13. 2026-08-14 优化验收补充

### 13.1 对话上下文与 Skill

- 会话的上下文面板必须允许用户添加、移除和查看知识空间、Wiki 页面、ResourceVersion 或已确认 Course；系统将其解析为 Binding 和 `/knowledge/{spaceId}/...` 虚拟路径。
- 路径不是文本输入能力：Host 路径、用户设备路径、Blob URI、数据库 URI、`..`、符号链接语义和上传资料中建议的路径均不能进入 Tool 或 Skill 输入。
- 每轮回答先重核 Binding，再执行 `knowledge.search` 与必要的 `knowledge.read`，再调用模型。回答使用自然语言，来源以独立区域呈现；检索命中列表只可作为明确降级结果。
- Skill 先通过 Policy、Approval、Sandbox 和 Worker，再可读取由 Binding 派生的受控 JSON。它不能因对话、模型或上传资料中的文字而扩大范围、添加路径或获得网络/Shell 权限。

### 13.2 学习、测试与报告

- 用户选择内容和学习目标后，`plan-compose` 只产生可编辑 draft；用户确认后才固化计划和学习单元。
- 学习者进入固定 ResourceVersion 原文。学习进度、书签、媒体位置、作答和评分均追加/版本化保存，不能被后续知识编译覆盖。
- 生成练习和测评的 Skill 只生成 candidate，正式发布、客观评分、主观复核、掌握度和报告指标由领域服务重核。每题都要关联知识点和 SourceLocator。
- Web、PNG、PDF 报告共享同一确定性 JSON；任何 AI 解释必须标为推断，且不能伪造成绩、时长或完成率。

### 13.3 增量验收

- 在只绑定一个 Wiki 页面的会话中，连续追问的 ToolCall、EvidenceBundle、回答与引用不能出现同空间其他页面或其他空间的同关键词资料。
- 同一学习计划包含一份文字和一份视频时，重新进入后仍打开历史版本的对应原文与视频时间点；播放不自动完成单元。
- 每道生成题可打开来源；重新执行客观评分结果一致；低置信度主观评分进入复核；报告每项指标可链接 LearningEvent、Attempt 或 Grade。
- Pi/OpenCode/Claude Code 任一评估失败，仍能使用内部 Adapter 保留会话、来源、权限和学习记录；不能用第三方运行时绕过上述断言。
