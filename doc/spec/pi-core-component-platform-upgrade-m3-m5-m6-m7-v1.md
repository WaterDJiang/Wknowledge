# Pi 核心与可组合领域组件升级 Spec v1

## 1. 关联工作包

- `M3-13`：LLM Wiki 组件契约。
- `M5-13`：Pi Core 生产适配器。
- `M5-14`：Agent Skills 兼容与受管 ResourceLoader。
- `M5-15`：组件 Tool Registry 与 Policy Bridge。
- `M5-16`：Pi 会话、事件与持久化桥接。
- `M6-14`：Assessment 组件契约。
- `M6-15`：Learning 组件契约。
- `M7-12`：数据库与队列运行档案。
- `M7-13`：旧运行时迁移与清理。
- `M7-14`：本地 App 安装包与验收。

状态：实施中。开发顺序以
[Pi 核心组件平台升级计划](../plan/pi-core-component-platform-upgrade-v1.md)为准。

## 2. 目标

将 Wknowledge 从“一个应用同时拥有 Agent、Skill、Wiki、考试和学习实现”升级为可组合平台：

- Pi 负责对话循环、Tool Call、上下文转换、流式事件、停止/继续和 Skill 使用编排。
- LLM Wiki、Assessment、Learning 是可独立装配的领域组件。
- `SKILL.md` 是面向 Agent 的标准说明；业务执行只能通过已注册的 Tool/API。
- 本地 App 使用 SQLite 和本地文件，线上部署使用 PostgreSQL、pg-boss 和受管文件存储。
- 迁移完成后删除不再承担生产职责的自研 Agent Loop、旧 Skill 主契约和专用分发路径。

## 3. 目标架构

```text
Web / Desktop / Mobile
→ Application API
→ Pi Runtime Kernel
   ├── tenant-scoped Skill catalog
   ├── Tool Registry
   ├── Policy / Approval Bridge
   ├── Session / Event Bridge
   └── Model Gateway Bridge
→ Domain Components
   ├── LLM Wiki
   ├── Assessment
   └── Learning
→ Runtime Profiles
   ├── local app: SQLite + local queue + local Blob/Wiki
   └── server web: PostgreSQL + pg-boss + local/S3 Blob/Wiki
```

Pi 不直接访问业务数据库、Blob、Wiki 文件、用户目录、Shell、Git、Docker Socket 或模型密钥。

### 3.1 固定的组合根与主入口

- `apps/web` 与 `apps/worker` 只组成**服务器 Web 运行档**：Pi 是对话与 Tool/Skill 编排的默认入口；状态只能由 PostgreSQL、pg-boss 和受管 Blob/Wiki Port 承载。该档不得读取 `runtime.sqlite`、`domain.sqlite` 或以环境变量把数据库切换为 SQLite。
- 本地 App 是独立安装产物和独立组合根（M7-14）：同一个 Pi Kernel 与领域组件装配 SQLite、本地队列、本地 Blob/Wiki 和受管本地 Skill 目录；它不复用 Docker Compose、`apps/web` 或 `apps/worker` 作为本地数据库宿主。
- 两档共享 Component Port、Schema、Pi Adapter、Policy、Tool Registry 与受控 Skill 格式；不共享数据库实例、队列实例、数据目录或“按环境临时切库”的配置。
- `runBoundKnowledgeAgent` 只保留在迁移对照测试和受控应急回退中。服务器正常请求默认且必须进入 Pi；`WKNOWLEDGE_AGENT_LOOP=internal` 是显式、可审计的短期应急开关，不是 SQLite/local App 的配置，也不得成为部署默认。

## 4. 组件契约

### 4.1 LLM Wiki Component

必须提供稳定的 TypeScript Port；后续可以增加 HTTP/MCP Adapter，但本地 App 默认使用进程内调用。

```ts
interface KnowledgeComponent {
  listScopes(input: AuthorizedKnowledgeScope): Promise<KnowledgeScopeSummary[]>;
  search(input: KnowledgeSearchInput): Promise<EvidenceBundle>;
  read(input: KnowledgeReadInput): Promise<KnowledgeExcerpt>;
  openSource(input: SourceOpenInput): Promise<AuthorizedSourcePreview>;
}
```

- Markdown Wiki、CompiledNode、SourceLocator 和发布协议仍是组件内部真相源。
- Pi 只能收到经过授权、裁剪和标记为不可信的数据结果。
- `knowledge.search/read/source.open` 是 Pi Tool，不是数据库查询接口。

### 4.2 Assessment Component

```ts
interface AssessmentComponent {
  composeCandidate(input: AssessmentCandidateInput): Promise<AssessmentCandidate>;
  publish(input: PublishAssessmentInput): Promise<AssessmentSnapshot>;
  submit(input: SubmitAttemptInput): Promise<AttemptSnapshot>;
  gradeObjective(input: GradeObjectiveInput): Promise<GradeSnapshot>;
  requestReview(input: RequestReviewInput): Promise<ReviewTask>;
}
```

- Skill 只能生成 candidate；发布、作答、评分和复核由领域服务确定化执行。
- 正式题卷、Attempt 和 Grade 不进入 Pi Session 作为业务真相源。

### 4.3 Learning Component

负责目标、计划、Course/Unit、学习事件、进度和报告；所有计划激活、进度、指标和报告快照继续由领域服务写入。

## 5. Pi 采用边界

- 生产核心使用锁定版本的 `@earendil-works/pi-agent-core`。
- 采用当前上游版本前必须先满足其 Node.js Engine；开发机、CI、容器与安装器使用同一 Node 基线。
- 不嵌入 Pi TUI 或完整 Coding Agent CLI。
- 若复用 `@earendil-works/pi-coding-agent` 的 Skill/ResourceLoader SDK，必须关闭默认工具和隐式宿主目录发现，仅注入 Wknowledge 自有 ResourceLoader 与 custom tools。
- `beforeToolCall` 必须调用 Wknowledge Policy；`afterToolCall` 必须完成结果裁剪、审计和稳定错误归一。
- Provider 仍由 Wknowledge Model Gateway 决定数据策略、凭据、预算、fallback 和审计。
- 上游升级必须重新执行依赖树、生命周期脚本、摘要、轨迹和安全反例门禁。

## 6. Agent Skills 与安装契约

### 6.1 标准 Skill

```text
skills/{skillId}/
├── SKILL.md
├── references/
├── scripts/
└── assets/
```

- `SKILL.md` 是名称、描述、工作流和渐进披露的作者真相源。
- 只有说明和引用的 Skill 可直接作为 instruction-only Skill 安装。
- Skill 内文本、脚本和资源全部按不可信安装内容处理。

### 6.2 可执行扩展

需要执行脚本的 Skill 额外提供：

```text
wknowledge.manifest.json
```

该文件只声明受支持的 runtime、入口、输入输出 Schema、能力、产物和资源上限；最终权限来自系统策略、组织策略、安装快照、会话 Binding 和本次批准的交集。

平台安装时生成不可变记录：来源、版本、文件摘要、发布者、兼容性、权限差异和安装时间。不得在运行时直接读取用户原始 Skill 目录。

### 6.3 本地与线上发现

- 本地个人版：用户显式选择目录或包；不得静默扫描整个主目录。
- 线上多租户版：只读取组织受管目录或已上传包；不得读取宿主机 `~/.pi`、`~/.codex`、`~/.claude`。
- 冲突时按组织固定安装版本解析，不使用“先扫描到者获胜”。

## 7. 存储与运行档案

### 7.1 本地档案

```text
data/
├── runtime.sqlite       # Pi 会话、消息、事件和运行快照
├── domain.sqlite        # 身份、权限、Wiki 元数据、考试与学习状态
├── blobs/
└── spaces/
```

### 7.2 服务器档案

- PostgreSQL：身份、权限、业务状态、审计和 Pi 会话投影。
- pg-boss：可靠队列、重试与死信。
- 本地卷/S3：Blob。
- Markdown volume：Compiled/Wiki/Mapping。

Pi 生态提供的 SQLite Session Backend 不能代替领域数据库。组件只依赖 Repository、Transaction、JobQueue、BlobStore 和 WikiStore Port，不依赖 Drizzle PostgreSQL 类型或 pg-boss 实例。

SQLite Adapter 的存在不代表服务器 Web 可以选择 SQLite；它们只由本地 App 的组合根实例化。

## 8. 兼容迁移

- 先双读/双运行验证，后切默认，再删除旧路径。
- 现有会话、消息、SkillRun、Assessment、Attempt、Grade、SourceLocator 和审计 ID 不得重建或改号。
- 现有 PostgreSQL 数据先通过新 Repository 读取；SQLite 是新增本地档案，不把生产数据自动降级复制到用户设备。
- `skill.json` 迁移为 `SKILL.md + wknowledge.manifest.json + 安装快照`；迁移工具必须保留原始 digest 和版本映射。
- 任一阶段失败时可以切回旧读路径；清理阶段完成后不再提供旧生产执行回退。

## 9. 旧组件清理清单

| 旧组件/路径                                | 目标                                         | 删除门禁                                    |
| ------------------------------------------ | -------------------------------------------- | ------------------------------------------- |
| `InternalAgentCoreAdapter` 生产导出        | Pi Adapter；脚本实现移入测试夹具             | Pi 轨迹、取消、工具、恢复和安全测试全部通过 |
| `runBoundKnowledgeAgent` 专用问答循环      | Pi `knowledge.*` Tool 循环                   | 知识对话 E2E 与引用一致性通过               |
| `skills/builtin/*/skill.json` 主契约       | `SKILL.md` + 可选 `wknowledge.manifest.json` | 内置 Skill 全部迁移且 digest 映射通过       |
| `loadSkillManifest/discoverSkillManifests` | 受管 Agent Skills ResourceLoader             | 本地/组织发现、冲突、禁用、撤权测试通过     |
| `worker:learning-generation` 特殊入口      | Assessment/Learning 组件 Tool Handler        | 计划和练习 candidate 行为等价               |
| `packages/skill-runtime` 的发现职责        | Pi Skill catalog；包只保留隔离执行职责并改名 | 所有调用方完成迁移                          |
| 领域服务直接 `getDatabase/schema`          | 组件 Repository Port                         | PostgreSQL 与 SQLite 契约测试通过           |
| 领域代码直接构造 pg-boss                   | JobQueue Port；pg-boss 保留服务器 Adapter    | 本地队列与服务器队列恢复测试通过            |
| “Pi 仅候选”的当前决策文字                  | 本 ADR/Spec 为新真相源；旧文档标记被取代     | INDEX 和交付状态无冲突表述                  |

不得删除历史迁移、审计记录、业务表、Wiki 历史版本或验证日志。历史文档保留，但必须标注其决策已被新 ADR 取代。

## 10. 验收标准

- 同一 App 可以只装 LLM Wiki，也可以组合 Assessment 和 Learning。
- Pi 只能调用当前用户、组织和 Binding 允许的 Tool/Skill。
- Codex/Claude/Pi 风格的标准 `SKILL.md` 可作为 instruction-only Skill 导入。
- 可执行 Skill 未提供 Wknowledge 执行清单或未通过 Sandbox 时不能执行。
- 知识回答的 EvidenceBundle 和 SourceLocator 与迁移前一致。
- 正式考试状态不依赖 Pi Session，可在 Pi 会话丢失后继续作答和评分。
- 本地 SQLite 完成“安装 → 初始化 → 上传 → 编译 → 对话 → 生成候选试卷 → 作答 → 报告”。
- 服务器 PostgreSQL/pg-boss 路径保持现有权限、恢复和审计行为。
- 服务器会话请求默认记录 `agent_loop.routing=pi`；未显式应急配置时不得落入 internal。`apps/web`/`apps/worker` 的模块图不得导入 `node:sqlite` 或本地 App 数据目录。
- 旧生产 Loop、旧 `skill.json` 主契约和特殊学习生成分发已从产物与运行依赖中移除。

## 11. 非目标

- 不开放通用 Bash、Git、任意宿主路径和 Docker Socket。
- 不让 Skill 直接读写数据库。
- 不把 Pi Session 当作 Wiki、Assessment 或 Learning 事实源。
- 不在首期建设公开第三方 Skill 市场。
- 不在迁移期间重写已验证的确定性评分和来源定位规则。
