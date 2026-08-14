# 会话 Skill 执行可用性 M5-06/M5-10 Spec v1

## 1. 关联计划

- 工作包：`M5-06`、`M5-10`，依赖已验证的 Skill Registry、Policy、Approval、SkillRun Outbox 和固定 `wiki-lint` Worker。
- 上游：[受控内置 Skill 执行](builtin-skill-execution-m5-06-m5-07-v1.md)、[模型与 Skill 管理设置](model-skill-settings-m5-03-m5-08-m5-10-v1.md)。
- 状态：开发中。本切片只校正会话工作台与 HTTP 控制面表达的执行事实，不加载新入口、模型、网络或动态 Skill。

## 2. 问题与目标

- 已安装的 `wiki-query`、`wiki-compile`、`wiki-correct` 会被旧会话 UI 显示为“可加入安全队列”，但 Worker 只支持 `wiki-lint`，导致用户可创建一个必然失败的 Run。
- 显式区分对话内置能力、已接通 Worker 的只读能力和“已配置但尚未接入执行器”的能力；不把配置或审批误称为可运行。

## 3. 固定执行状态

| Skill                          | 会话显示     | 可从会话手动入队 | 当前实现                                                       |
| ------------------------------ | ------------ | ---------------- | -------------------------------------------------------------- |
| `wiki-query`                   | 对话内置     | 否               | 每轮问答受控调用 `knowledge.search/read` 与 Markdown Wiki 查询 |
| `wiki-lint`                    | Worker 只读  | 是               | 固定编译期调用 `lintWikiDirectory`                             |
| `wiki-compile`、`wiki-correct` | 执行器待接入 | 否               | 仅保留安装/策略/审批元数据，不加载 entrypoint                  |

- 已由组织管理员受管发现、启用且通过固定 CLI Sandbox 准入的动态 Skill 也显示为“受管 Worker”，可按其 Policy/Approval 加入安全队列；这不等同于授予模型、网络、原始文件或任意 Shell。
- Worker 完成动态 Skill 后，界面只显示 runtime、受管范围数量和输出形状等脱敏摘要；不展示输入、输出正文、宿主路径、Blob URI、凭据或任意子进程日志。
- `plan-compose`、`practice-generate` 仍只从学习页面创建私有请求，通用会话入口必须拒绝，不能因显示为 Worker 而绕过学习范围。

- 列表 API 为每项可见 Skill 返回上述状态；UI 不为不可入队的状态展示请求批准或加入队列按钮。
- `POST /skill-runs` 在创建记录前拒绝不是 `worker` 的 Skill，返回 `SKILL_EXECUTION_UNAVAILABLE`；不能依赖 Worker 之后失败来表达该状态。
- `permissions.resources = space` 的 Worker Skill 只能使用完整 `space` Binding。若会话当前选择 Wiki 页面、ResourceVersion 或 Course 子范围，Policy 列表不暴露该 Skill；直接请求批准或入队也必须在创建 Approval、SkillRun 和 Outbox 前以 `SKILL_POLICY_DENIED` 拒绝，绝不把子范围扩大为整空间。
- 混合范围会话若包含至少一个完整 `space` Binding，完整空间 Skill 仍可用，但控制面只传递完整空间 Binding；页面/资料版本/Course Binding 不会被随附到该 Skill 输入中。
- Worker 继续对旧队列或绕过控制面的未知 Skill 返回稳定失败，不扩张其固定执行白名单。

## 4. 安全与可追溯

- 执行状态是服务器固定代码映射，不取自 Manifest、模型、用户输入或上传资料。
- 不改变现有 Policy、Approval、Manifest digest、Binding、Worker 重新校验或审计语义。
- `wiki-query` 仍由对话 Route 在受管 Binding 内运行；它不是任意路径或全文读取工具。

## 5. 验收

- 前端能清楚呈现三类状态；`wiki-lint` 与已受管安装的动态 CLI 可按 Policy/Approval 入队，学习生成 Skill 仍只能从学习页面触发。
- 非 `worker` Skill 直接调用 SkillRun HTTP API 返回 409，且不创建 SkillRun/Outbox。
- 页面/资料版本/Course 子范围下请求 `wiki-lint` 被控制面拒绝，且不创建 Approval、SkillRun/Outbox；完整空间 Binding 下现有只读 Lint 不受影响。
- `wiki-lint` 已有的审批、排队、Worker 与摘要回归不受影响。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 通过。
