# Skill Sandbox 准入 M5-06/M5-07 Spec v1

## 1. 关联计划

- 工作包：`M5-06`、`M5-07`，位于既有 SkillRun/Outbox、Policy/Approval 和固定 `wiki-lint` 只读 Handler 之后。
- 上游：[SkillRun 与 Worker 执行边界](skill-run-worker-boundary-m5-06-v1.md)、[受控内置 Skill 执行](builtin-skill-execution-m5-06-m5-07-v1.md)。
- 状态：开发中。进程启动前的准入、独立目录、固定 JSON I/O、Linux Bubblewrap fail-closed 运行器及内部 Worker 调用链已交付；管理端动态安装发现、模型和学习 Skill 仍未启用。

## 2. 目标

- 让 TypeScript CLI Skill 与 Python JSON CLI Skill 在真正启动前获得可审计的、最小权限的运行许可。
- 将“可安装”“策略允许”“用户批准”“可被 Worker 安全执行”严格分开；前 3 项都不能自动等于第 4 项。

## 3. 初期执行模型

```text
SkillRun queued
→ Worker claim + 重新授权
→ SandboxAdmission 校验
→ 创建 run/{skillRunId}/input + artifacts
→ 只读挂载受管派生输入
→ 参数数组启动固定 CLI
→ stdout JSON Schema 校验
→ 领域服务重核/持久化脱敏摘要
→ completed | failed
```

- 原始 Blob、`raw/`、Wiki 发布目录、数据库连接串、环境密钥与宿主工作目录永不进入 Sandbox。
- 输入只能由 Worker 从 active Binding 和固定版本生成；Skill 不接收用户路径、任意 URL、任意 shell 文本或上传文档中的命令。
- 每个 Run 使用独立受管目录：`input/` 只读、`artifacts/` 可写、`tmp/` 可写；Run 结束后仅通过 BlobStore 发布已校验 Artifact。
- Sandbox 目录名只接受 `SkillRun` UUID。Worker 先规范化/真实解析受管 Sandbox 根目录，再创建 `run/{skillRunId}/input`、`artifacts`、`tmp`；任一解析结果在根目录外、符号链接或非法 ID 时拒绝，且不创建目录。
- Sandbox 根、每个 Run 目录和三个子目录在创建后都收紧为 `0700`；固定输入文件为 `0400`。这降低同机其他账号在 Worker 运行中替换路径的机会，但同 UID 的恶意进程仍不受此机制隔离。
- 本阶段输入固定写为 `input/input.json`，内容是 `{ schemaVersion: 1, input }`。文件名不可由用户、Manifest 或上传文档决定；序列化失败、超过 1 MiB、目录契约不一致或不符合受限 JSON Schema 均以稳定错误拒绝。
- 本阶段产物固定读取 `artifacts/result.json`，内容是 `{ schemaVersion: 1, output }`。只读取常规文件、大小不超过 1 MiB、可解析为 JSON 的内容；符号链接、目录、空文件、非法 JSON、不匹配 schemaVersion 或输出 Schema 均拒绝。受限 Schema 仅支持 `type`、`required`、`properties`、`items`、`enum` 和 `additionalProperties: false`；任意 `$ref`、组合或未支持关键字拒绝，不静默忽略。
- 入口名只可映射到 Worker 维护的 `typescript-json-cli` 或 `python-json-cli` registry 记录；Manifest 只声明入口 ID，不能声明二进制、脚本文件、工作目录、环境变量或参数。入口 registry 在真正启动子进程前仍需绑定供应链摘要与 OS 隔离配置。
- `input/input.json` 在写入后设为只读，作为当前 Worker 内部接口的防御层。它不等同于 OS 隔离：真正的只读挂载、网络隔离、cgroup/namespace 和 UID 降权仍是启动子进程前的后续门禁。
- 首批动态执行仅支持 `network: deny`、显式时限、零提权和参数数组。Linux 运行器必须以 Bubblewrap 新用户/挂载/PID/网络命名空间启动，缺失运行时或非 Linux 时 fail-closed；`network: allowlist`、cgroup CPU/内存、seccomp 和其他平台等价隔离作为后续生产加固项。

## 4. 准入矩阵

| 条件                                          | 初期动态 CLI 是否可执行 | 处理                                                  |
| --------------------------------------------- | ----------------------- | ----------------------------------------------------- |
| Manifest/digest 与 SkillRun 快照不一致        | 否                      | `SKILL_MANIFEST_CHANGED`                              |
| 安装已停用、范围撤销、审批过期                | 否                      | 现有稳定拒绝码                                        |
| `network !== deny`                            | 否                      | `SKILL_SANDBOX_NETWORK_UNSUPPORTED`                   |
| `filesystem` 不是 `none/read/write-artifacts` | 否                      | `SKILL_SANDBOX_FILESYSTEM_UNSUPPORTED`                |
| `requiredCapabilities` 非空                   | 否                      | `SKILL_SANDBOX_MODEL_UNSUPPORTED`                     |
| entrypoint 不是受管 registry 中的固定 CLI ID  | 否                      | `SKILL_ENTRYPOINT_DENIED`                             |
| input/output Schema 不通过                    | 否                      | `SKILL_IO_SCHEMA_INVALID`                             |
| 超时、内存或取消                              | 否                      | 终止进程，保存稳定错误码，不保存 stdout/stderr 正文   |
| 所有条件通过                                  | 是                      | 仅可写已校验 artifacts，审计版本/digest/资源计数/耗时 |

## 5. 学习 Skill 特别边界

- `practice-generate`、`assessment-generate`、`plan-compose`、`rubric-grade` 在此准入与模型数据策略、预算、输出 Schema 和领域重核都完成前，均显示“执行器待接入”。
- `practice-generate` 的可读输入只能是当前用户已完成单元的固定知识点、SourceLocator、目标难度和本人历史 Attempt 脱敏统计；不能接触答案键、其他用户、原始 Blob、整空间正文或未完成单元。
- Skill 输出永远只是 Schema 校验后的 candidate；领域服务再重核 Course/KnowledgePoint/ResourceVersion/SourceLocator。Skill 不得创建 active Plan、正式题卷、Attempt、Grade、学习事件或报告。

## 6. 验收

- 对每个准入矩阵拒绝分支有确定性单元测试，且拒绝时不创建目录、不启动进程、不写 Artifact。
- 固定 JSON I/O 覆盖成功读写、超限、循环/不可序列化输入、符号链接、非法 JSON、错误 envelope 与目录替换反例；任何失败不得读取或写出根目录外内容。
- 允许的固定 CLI 只能看到受管 JSON 输入和独立 artifact 目录；不存在数据库凭据、Blob URI、宿主路径或写入原件的能力。
- stdout JSON、超时、非零退出、超资源和取消均进入稳定终态；日志与 SkillRun 摘要不含原文、答案键、模型密钥或完整 stderr。当前运行器已覆盖 stdout 隔离、超时/取消/非零退出与 result 重核；cgroup 超资源限制待生产加固。
- `wiki-lint` 保持固定编译期调用，不迁移到动态入口；不因本切片开放 `wiki-compile`、`wiki-correct` 或生成型学习 Skill。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 通过；涉及 Worker 进程隔离时追加故障与 E2E 验收。
