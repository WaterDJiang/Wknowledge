# 开源 Agent 与 LLM Wiki 参考

- 核对日期：2026-08-14。

| 来源                                                                                                                                        | 许可证/性质                                  | 借鉴                                                                 | 不直接复制的内容                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Karpathy LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)                                                      | 设计草案                                     | raw/wiki/schema、index、log、compile/query/lint                      | 个人脚本不是多用户业务后端                                                    |
| [Pi Mono](https://github.com/badlogic/pi-mono) / `@mariozechner/pi-agent-core`                                                              | MIT、可嵌入包                                | 事件流、消息转换、上下文裁剪、工具前后拦截、停止/继续、Provider 抽象 | agent core 本身不是文件/进程/网络权限隔离；不能把其 Coding Agent 权限带入产品 |
| [OpenCode](https://github.com/anomalyco/opencode) / [Skills](https://opencode.ai/docs/skills/)                                              | MIT、完整 Coding Agent                       | Skill 摘要发现、按需加载、通配符 `allow/ask/deny`、会话和工具状态 UX | `opencode.json` 不能替代组织/空间 RBAC，不复用通用 Shell 权限默认值           |
| [Claude Code Hooks](https://code.claude.com/docs/en/hooks) / [Agent SDK Permissions](https://code.claude.com/docs/en/agent-sdk/permissions) | 官方公开文档和 SDK；CLI 不作为开源运行时依赖 | Hooks 生命周期、deny 优先、ask/allow、工具调用拦截、Skills 与会话 UX | 不复制闭源 CLI，不把 Anthropic Provider 变成强依赖，不执行未受控主机 Hook     |
| [OpenClaw Sandbox](https://docs.openclaw.ai/gateway/sandboxing)                                                                             | 设计参考                                     | Gateway/执行区分离、工作区挂载                                       | 不把普通容器当成完美安全边界                                                  |

## Agent 对话适配判断

- 首选 Spike：在 `packages/agent-runtime` 后接 `@mariozechner/pi-agent-core` adapter，对比现有内部 loop。
- OpenCode 主要作为 Skill/权限和交互参考，不在首期嵌入其完整服务端或桌面端。
- Claude Code 只作为公开行为规范参考；其官方 GitHub 仓库包含插件和问题跟踪，但不等同于可复用的完整 CLI 源码。
- 不从 Coding Agent 继承 Bash、Git、主机路径、用户目录或凭据访问能力。
- 所有候选均通过脚本化 Provider 的工具轨迹测试、取消测试、上下文裁剪测试和提示注入测试。

## M5-00 准入产物

- 每个候选在进入依赖前必须归档来源 URL、tag/commit、许可证、完整依赖树、生命周期脚本、包摘要和替换测试结果。
- Pi 是首个可嵌入的 AgentCoreAdapter 候选；OpenCode 仅在 M5-00 审核后才可成为局部适配候选，不能以整套 Coding Agent 方式嵌入。
- Claude Code 是公开产品文档参考，不在“开源可嵌入依赖”清单中。
- Spike 固定为三段：Pi 与内部 Loop 的 20 条脚本化轨迹对比、OpenCode Skill/权限语义映射、Claude Code 公开会话/审批/Hook UX 对照。三段都不得接入真实知识正文、生产 Provider 密钥或宿主机目录。
- Pi 的统一 Provider API 可作为模型适配接口的参考，但 Provider 密钥、空间数据策略、预算和审计仍由 Wknowledge Model Gateway 管理。

## M5-00 本轮核对与采用结论

- Pi 官方仓库将 `@earendil-works/pi-agent-core` 描述为带工具调用和状态管理的运行时，并明确声明其不内建文件系统、进程、网络或凭据权限限制；默认按启动进程的权限运行。因此其只能位于 Wknowledge `AgentCoreAdapter` 后，且在隔离供应链审查前不安装。参考：[Pi README](https://github.com/earendil-works/pi)。
- Pi 自身文档建议安装时使用 `--ignore-scripts`，并说明依赖生命周期脚本需要显式 allowlist；这与本项目“先审查、后锁定”的准入顺序一致，但不是替代审查的证据。参考：[Pi README](https://github.com/earendil-works/pi)。
- OpenCode 文档表明 Skill 可被摘要列出并按 `allow`、`deny`、`ask` 权限控制；`deny` Skill 对 Agent 隐藏，`ask` 在加载前等待用户批准。M5-03 复现这三个语义，但不读取或采用 `opencode.json` 作为权限真相源。参考：[OpenCode Skills](https://opencode.ai/docs/skills/)。
- Claude Code 公开权限文档给出 deny → ask → allow 的优先次序，并说明 Hook 的 allow 不能覆盖 deny/ask；本项目后续 Policy Engine 采用同样的拒绝优先原则。Claude Code CLI 不作为依赖。参考：[Claude Code Permissions](https://code.claude.com/docs/en/permissions)。

## 2026-08-14 复核与当前决定

- Pi 当前公开仓库仍将 `@earendil-works/pi-agent-core` 定义为带工具调用和状态管理的运行时，并同时明确它不内建文件、进程、网络或凭据权限边界。即使其采用 MIT，也不能在 M5-06 Sandbox 之前作为服务端执行器安装；当前结论为“内部 Adapter 继续采用，Pi 维持未安装候选”。参考：[Pi README](https://github.com/earendil-works/pi)。
- Pi 的 `npm install --ignore-scripts`、锁定直接依赖和生命周期脚本 allowlist 是可借鉴的供应链流程，不是本项目安装第三方 Agent 的授权。若将来启动 Pi Spike，必须在隔离目录归档准确 tag/commit、包/锁文件摘要、完整依赖树和 lifecycle 清单，然后用内部的 20 条轨迹、取消、注入及 Adapter 替换测试决定采用或回退。
- OpenCode 当前 Skills 文档仍采用“摘要发现 → 显式加载 → allow/deny/ask”的模型。Wknowledge 已复用这种可见性语义，并进一步将“对话内置、Worker 可执行、执行器待接入”分开；不读取 `opencode.json`，也不嵌入其完整 Coding Agent。参考：[OpenCode Skills](https://opencode.ai/docs/skills/)。
- Claude Code 的公开权限说明仍提示复杂命令需按子命令分别校验，且 deny/ask 的工具匹配会从可见上下文中去除相应能力。这支持本项目的固定工具/固定 Worker 白名单，而不支持把主机命令匹配直接搬入知识平台。参考：[Claude Code Permissions](https://code.claude.com/docs/en/permissions)。

### 本次准入结论

| 候选          | 结论                 | 当前可做                               | 明确不能做                                          |
| ------------- | -------------------- | -------------------------------------- | --------------------------------------------------- |
| Pi agent core | 未安装、继续评估     | 保持 `AgentCoreAdapter` 契约和内部回退 | 不作为权限/Sandbox，也不直连 Provider、数据库或文件 |
| OpenCode      | 不安装、模式已映射   | 摘要发现、allow/ask/deny、按需呈现     | 不读取其配置或运行完整 Coding Agent                 |
| Claude Code   | 不安装、公开 UX 对照 | 拒绝优先、工具状态、审批/Hook 交互原则 | 不运行 CLI、Hook、账户或主机权限                    |

### 本轮实施约束复核

- Pi 官方 README 明确其 Agent Core 提供工具调用和状态管理，但不内建文件、进程、网络或凭据限制。因此它只能作为 `AgentCoreAdapter` 候选；动态 Skill 的隔离仍必须由 Wknowledge Worker/Sandbox 负责。参考：[Pi README](https://github.com/earendil-works/pi)。
- OpenCode 的 Skills 文档采用“摘要列出、按需加载、`allow/deny/ask` 控制可见性”的模式。Wknowledge 复用这三个交互语义，但由自身 Manifest、组织/空间 RBAC、Approval 与审计决定最终权限，不读取 OpenCode 配置文件。参考：[OpenCode Skills](https://opencode.ai/docs/skills/)。
- Claude Code 的 Hooks 文档将生命周期拦截视为可执行命令/端点，并明确提示命令 Hook 拥有启动用户的完整权限。Wknowledge 只借鉴工具前后状态与拒绝优先体验；不运行外部 Hook，所有执行仍经过固定 Worker Sandbox。参考：[Claude Code Hooks](https://code.claude.com/docs/en/hooks)。

## 学习模块可复用边界

- 复用 Agent loop、Skill discovery、权限拦截和 Artifact 登记机制。
- 学习计划、题目、作答、评分和报告继续使用 Wknowledge 领域 Schema，不使用第三方 Agent 会话文件代替业务数据库。
- 报告图片使用确定性模板渲染；模型只产生有标记的文字解释，不直接计算成绩指标。

## 引用规则

- 只复用经过产品边界审查的设计模式。
- 不把 Coding Agent 的高权限默认带入知识与学习系统。
- 第三方代码进入产品前审查许可证、供应链和发布活跃度。
- 固定依赖版本/commit 和摘要；上游升级必须重跑适配契约与安全测试。

## 2026-08-14 产品化采用结论

- 对话产品采用 Pi 的“可替换 Agent core”思路，而非直接安装 Pi：Wknowledge 保持内部 `AgentCoreAdapter`，对话范围、模型路由、来源、权限和审计继续由平台控制。
- Skill 产品采用 OpenCode 的“摘要发现、按需加载、`allow/ask/deny`”交互语义；实际 Manifest、组织/空间 RBAC、Approval、Worker 和 Sandbox 均为 Wknowledge 自有实现。
- Claude Code 仅作为工具状态、拒绝优先和 Hook 生命周期的公开 UX 对照。它不是本项目的运行时依赖，也不能取得知识库或宿主权限。
- 当前优先级是对话范围/Provider 的已登录验收与受控 Skill 执行，再交付 `plan-compose`、`practice-generate`、`assessment-generate` 和 `rubric-grade` 的候选输出。任何框架评估失败都不改变此顺序。
