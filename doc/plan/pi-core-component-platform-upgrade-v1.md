# Pi 核心组件平台升级计划 v1

## 1. 计划目标

将 Pi 设为服务器 Web 的默认 Agent 核心，把 LLM Wiki、Assessment、Learning 拆成可组合领域组件，同时交付独立本地 SQLite App 运行档案和受管 Agent Skills 安装能力。服务器 PostgreSQL 与本地 SQLite 由不同组合根装配，计划覆盖旧实现迁移、观察和删除，不以“新路径可运行”代替清理完成。

关联 Spec：[Pi 核心与可组合领域组件升级](../spec/pi-core-component-platform-upgrade-m3-m5-m6-m7-v1.md)。

## 2. 排期假设

- 团队：2–5 人。
- 节奏：两周一个 Sprint；架构冻结周为短 Sprint 0。
- 起始日期：2026-08-18。
- 计划完成：2026-12-11。
- 日期是开发基线，不是上线承诺；安全门禁失败时顺延，不压缩清理和迁移观察期。

## 3. 执行原则

- 先建立 Adapter 和组件契约，再迁移功能。
- 新旧路径输出可对比，但同一业务写操作只能有一个真相源。
- 先迁移知识对话，再迁移考试/学习生成。
- SQLite 与 PostgreSQL 运行相同 Repository 契约测试。
- 旧组件删除是独立交付，不留“暂时还在”的生产旁路。
- 每个 Sprint 结束更新交付状态、索引和当日日志。

## 4. 开发排期

| Sprint | 日期         | 工作包      | 主要交付                                                                                   | 退出门禁                                                        |
| ------ | ------------ | ----------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| S0     | 08-18～08-21 | M5-13       | 锁定 Pi 来源/版本；依赖树、许可证、lifecycle、摘要；冻结 Node 版本和事件/Tool/Session 映射 | 供应链记录完整；Node 基线兼容；ADR/Spec/计划评审通过            |
| S1     | 08-24～09-04 | M5-13/M5-16 | `PiAgentCoreAdapter`、Model Gateway Bridge、流式/停止/工具事件映射；内部 Adapter 对照      | 既有 20 条轨迹 + 真实合成 Tool Loop 等价；无数据库/宿主权限泄漏 |
| S2     | 09-07～09-18 | M5-14/M5-15 | tenant-scoped ResourceLoader、`SKILL.md`、Tool Registry、Policy/Approval Hooks、安装快照   | 不扫描服务器主目录；deny/ask/allow、撤权和版本漂移失败关闭      |
| S3     | 09-21～10-02 | M3-13       | LLM Wiki Component Port；`knowledge.list/search/read/source.open`；现有问答旁路对比        | EvidenceBundle、SourceLocator、拒答与范围结果一致               |
| S4     | 10-05～10-16 | M7-12/M5-16 | Repository/Transaction/JobQueue Port；Pi Session 投影；SQLite/local queue 首切片           | PostgreSQL 与 SQLite 契约测试通过；恢复/取消/幂等一致           |
| S5     | 10-19～10-30 | M6-14       | Assessment Component；考试 Skill；候选、发布、作答、确定性评分和复核 Tool                  | 正式状态不依赖 Pi Session；每题来源可回查                       |
| S6     | 11-02～11-13 | M6-15       | Learning Component；计划、课程、事件、报告 Tool/Skill；移除专用模型循环依赖                | 计划/报告事实指标不由模型覆盖；历史快照一致                     |
| S7     | 11-16～11-27 | M7-13       | 数据/Skill 迁移工具、默认路径切换、双读观察、旧路径调用统计归零                            | 两个连续验证窗口无旧生产调用；回退演练通过                      |
| S8     | 11-30～12-11 | M7-13/M7-14 | 删除旧 Loop、旧主 Manifest、特殊分发；本地 App 初始化/升级/备份恢复/E2E                    | 清理清单归零；全新安装与旧数据升级验收通过                      |

## 5. 并行工作流

### A. Pi 核心与会话

- 负责人建议：1 名后端/运行时。
- S0–S2 完成 Pi Adapter、事件、Model Gateway 和 Policy Hook。
- S4 完成 Session Repository 与恢复。
- 任何 Pi 类型只存在于 `@wknowledge/agent-runtime` 内部。

### B. Skill 与安全执行

- 负责人建议：1 名后端/安全，可与 A 并行。
- S1 准备 Agent Skills 解析、安装快照和迁移映射。
- S2 接通 ResourceLoader 和 Tool Registry。
- S7/S8 将 `packages/skill-runtime` 收敛为纯执行/Sandbox 包并完成改名或拆分。

### C. 领域组件

- 负责人建议：1–2 名全栈。
- S3 提取 LLM Wiki。
- S5 提取 Assessment。
- S6 提取 Learning。
- 页面和 Route Handler 只调用应用服务/组件 Port，不直接组合 Pi 或数据库。

### D. 本地运行档案与安装

- 负责人建议：1 名平台/测试，可从 S3 开始并行。
- S4 建立 SQLite 和 local queue。
- S7 完成迁移、备份和回退。
- S8 交付一键初始化与本地完整 E2E。

## 6. 工作包拆分

### M5-13：Pi Core 生产适配器

- 锁定准确包版本/commit 与摘要。
- 2026-08-17 S0 已锁定 `@earendil-works/pi-agent-core@0.84.2`（上游自 `0.78.0` 起均要求 Node `>=22.19.0`），项目 engines、容器基线与文档已统一到 22.19+；供应链档案见 [Pi Core 供应链档案](../ref/pi-core-supply-chain-v1.md)。
- Pi 事件映射到现有 AgentRun/ToolCall/SSE 契约。
- Model Gateway 作为唯一 Provider 路由。
- 默认只注册 Wknowledge custom tools。

验收：工具、停止、错误、上下文裁剪和多轮轨迹稳定；Pi 不能获得数据库、文件或密钥。

### M5-14：Agent Skills 兼容

- 读取标准 `SKILL.md`、references、scripts、assets。
- 本地显式目录导入；线上受管包安装。
- `skill.json` 转换器与 digest 映射。
- instruction-only 与 executable Skill 明确分级。

验收：Codex/Claude/Pi 风格 Skill 可导入；未声明执行契约的脚本不可执行。

### M5-15：Tool Registry 与 Policy Bridge

- 每个组件注册 Tool Schema、风险、所需 Scope 和 Handler。
- Pi `beforeToolCall` 调用当前权限/审批/预算。
- Pi `afterToolCall` 执行裁剪、来源挂接、审计和终止策略。

验收：撤权、越界、未批准、提示注入和伪造 Tool 参数均失败关闭。

### M5-16：会话与事件桥接

- Pi 运行态与业务 AgentSession 分离。
- 最终消息、ToolCall、EvidenceSnapshot、SkillRun 持久化。
- 本地 SQLite 与服务器 PostgreSQL 投影。

验收：刷新、停止、恢复和进程重启后历史一致；Pi Session 丢失不损坏业务对象。

### M3-13/M6-14/M6-15：领域组件

- 将数据库访问封装到组件 Repository。
- 为 Pi 提供窄 Tool，不暴露表、路径或连接。
- 组件拥有独立契约测试、迁移和错误码。

验收：组件可在无 Web UI 下独立测试；本地和服务器 Adapter 行为一致。

### M7-12：本地/服务器运行档案

- 本地 App 组合根固定 SQLite/local queue；服务器 Web 组合根固定 PostgreSQL/pg-boss，禁止 Web 环境变量切库。
- 本地数据根、锁、备份、恢复和升级检查。

验收：同一领域测试套件覆盖两种数据库；本地任务在崩溃后可恢复且不重复提交业务终态。

### M7-13：迁移与旧组件清理

- 旧/新结果对比和调用计数。
- Skill、Session 和组件数据迁移。
- 默认切换与回退演练。
- 删除 Spec 清单中的所有旧生产路径。

验收：构建产物不含旧生产入口；`rg`/依赖图/测试证明无调用；历史数据可读。

### M7-14：本地 App 安装

- 一键初始化、Schema migrate/seed、管理员创建。
- 本地 SQLite、Blob、Wiki 和 Skill 目录。
- 独立于 Docker Compose、`apps/web` 与 `apps/worker` 的本地组合根；Pi 仍是本地对话入口。
- 升级前检查、备份和失败恢复。

验收：干净机器完成上传、编译、知识对话、考试、作答和报告闭环。

## 7. 清理执行顺序

```text
标记 deprecated
→ 新路径旁路运行和差异报告
→ 新路径成为默认
→ 旧路径只读观察
→ 旧调用计数连续两个窗口为 0
→ 删除代码/依赖/配置/测试夹具外导出
→ 更新文档和安装产物
```

禁止在差异报告、数据回填、回退演练或新路径 E2E 未通过时提前删除。

## 8. 质量门禁

每个 Sprint 至少运行：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

涉及用户流程时追加 `pnpm test:e2e`；涉及 SQLite/PostgreSQL 时执行双 Adapter 契约测试；涉及删除时执行依赖图、产物内容和旧入口负向检查。

## 9. 风险与缓冲

| 风险                         | 影响              | 应对                                                |
| ---------------------------- | ----------------- | --------------------------------------------------- |
| Pi API/包结构变化            | Adapter 返工      | 锁版本、只经反腐层、S0 完成依赖档案                 |
| Pi 与项目 Node 基线不兼容    | 安装/构建失败     | S0 统一 Node、CI、容器和本地安装器版本后再接入依赖  |
| Skill 默认权限过宽           | 数据泄露/执行风险 | 自有 ResourceLoader、无默认工具、安装快照和 Sandbox |
| PostgreSQL 语义难映射 SQLite | 本地行为漂移      | 契约测试、避免依赖 PG 特有锁；必要时本地队列串行化  |
| 双路径长期存在               | 维护成本翻倍      | S7/S8 固定观察和删除门禁                            |
| 组件拆分破坏历史证据         | 引用/评分漂移     | 保持稳定 ID、快照和 SourceLocator；对比迁移前后输出 |

预留 S8 前 3 个工作日处理 S7 迁移遗留；若未使用，不提前宣称完成，转为安装和恢复演练。

## 10. 完成定义

- Pi 是唯一生产 Agent Loop。
- LLM Wiki、Assessment、Learning 均通过 Tool/API 组件契约接入。
- 标准 `SKILL.md` 是 Skill 作者入口，执行权限由平台独立管理。
- 本地 SQLite 与服务器 PostgreSQL 两条路径均通过完整闭环。
- Spec 第 9 节旧组件清理项全部完成，没有生产旁路或死配置。
- 文档、升级、备份、恢复和本地安装说明与实际产物一致。
