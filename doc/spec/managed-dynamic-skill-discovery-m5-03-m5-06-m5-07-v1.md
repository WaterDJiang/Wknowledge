# 受管动态 Skill 发现与管理 M5-03/M5-06/M5-07 Spec v1

## 1. 关联计划

- 工作包：`M5-03`、`M5-06`、`M5-07`；接续受管动态 CLI 的 Worker 执行切片。
- 上游：[动态 Skill Worker 执行](dynamic-skill-worker-execution-m5-06-m5-07-v1.md)、[模型与 Skill 管理设置](model-skill-settings-m5-03-m5-08-m5-10-v1.md)、[会话 Skill 可用性](session-skill-execution-availability-m5-06-m5-10-v1.md)。
- 状态：开发中。本切片让已由运维放入受管目录的安全动态 CLI 被发现、按组织启停，并在会话中如实标为可排队 Worker Skill；不提供浏览器上传、安装、升级或卸载。

## 2. 目标与范围

- 设置页同时列出内置 `skills/builtin/*` 与通过准入的 `skills/installed/{skillId}` Skill，并明确显示“内置”或“受管 CLI”。
- 组织管理员可启用/停用已发现的动态 Skill；数据库继续仅保存安装状态、版本和 digest，Manifest/程序仍是文件系统受管内容。
- 通过动态入口、非符号链接、固定程序名、程序 digest 与 Sandbox Admission 的动态 Skill，才可进入设置列表和会话 Worker 队列。
- 动态 Skill 和内置 Skill 同 ID 时拒绝动态 Shadow；避免管理页、控制面和 Worker 对同一 ID 的执行对象不一致。

## 3. 发现与执行语义

```text
运维受管投放 skills/installed/{skillId}/
→ regular directory + skill.json + run.mjs/run.py
→ Manifest / entrypoint / SHA-256 / Admission 验证
→ Settings 列表（组织启停）
→ Session Policy 显示 Worker 可执行
→ SkillRun / Worker 再次全量重核
```

- 只允许 `typescript-json-cli → run.mjs` 与 `python-json-cli → run.py`；不接受 Manifest 中的自由命令、参数、解释器、工作目录或环境。
- 目录、Manifest、程序均必须是常规非符号链接对象，真实路径在安装根内；任一检查失败时该安装项不进入可管理列表。
- `manifest.digest` 必须等于固定程序的 SHA-256；`evaluateSandboxAdmission` 必须允许（当前即无网络、无模型、固定 JSON CLI）。
- 控制面只把已发现的受管 CLI 映射为 `worker`。Worker 在认领时仍按既有语义重新检查版本/digest、安装状态、成员、Binding、Policy 和 Approval，不能信任设置页缓存。
- 对内置 Skill 保持既有固定执行状态；`wiki-query` 仍是会话对话内置，`wiki-compile`、`wiki-correct` 仍不可排队。

## 4. 安全与可追溯

- 本切片不执行安装目录中的代码，也不读取用户上传文件、Wiki 正文、Blob、数据库凭据或密钥。
- 发现失败不展示真实宿主路径、文件内容或堆栈；动态目录不是用户可写位置。
- 管理页只可修改组织级 `enabled` 状态；启停、版本和 digest 随现有 `skill.updated` 审计记录保存。
- 无有效 Linux Bubblewrap 运行时的 Worker 仍失败关闭；设置页的“受管 CLI”仅表示已通过静态准入，不代表本机已完成执行健康检查。

## 5. 验收

- 安全的 `skills/installed/{skillId}` 会与内置 Skill 一同列出，显示来源，组织启停后会话 Policy 和创建 SkillRun 都遵循该状态。
- 符号链接、未知入口、digest 不符、网络/模型要求、无效 Manifest 和内置同 ID Shadow 都不能被发现或排队。
- 动态已发现 Skill 在 Session 列表为 `worker`，而未发现/不可准入项继续无法创建 Run。
- 已有内置 Skill 的设置页、Policy、审批和 `wiki-lint` Worker 回归不受影响。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 通过。

## 6. 明确后置

- 浏览器上传、签名/Publisher 校验、安装包审计、版本回滚、卸载与隔离试运行。
- 动态 Skill 的模型、网络、原始文件读取、Artifact 发布和学习生成型 Skill。
- Linux 容器中的真实 Bubblewrap 队列端到端验收与资源限额观测。
