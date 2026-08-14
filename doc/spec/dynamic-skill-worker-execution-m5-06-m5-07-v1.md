# 动态 Skill Worker 执行 M5-06/M5-07 Spec v1

## 1. 关联计划

- 工作包：`M5-06`、`M5-07`，接续动态 CLI Sandbox 准入与 Bubblewrap 进程隔离。
- 上游：[动态 Skill 进程 Sandbox](dynamic-skill-process-sandbox-m5-06-m5-07-v1.md)、[Skill Sandbox 准入](sandbox-admission-m5-06-m5-07-v1.md)。
- 状态：开发中。本切片接通 Worker 对受管动态 CLI 的内部执行链路；受管目录的安全发现、组织启停和会话可执行性由后续 [受管动态 Skill 管理](managed-dynamic-skill-discovery-m5-03-m5-06-m5-07-v1.md) 接续，仍不开放浏览器安装、真实模型能力或学习生成 Skill。

## 2. 目标

- Worker 能把非内置的 queued `SkillRun` 分派给动态执行器，而固定 `wiki-lint` 继续由原内置 Handler 处理。
- 动态执行器只能从 `skills/installed/{skillId}` 发现常规目录、固定 `skill.json` 与固定程序文件，且入口内容摘要必须与 `SkillRun` 快照和 Manifest 一致。
- Worker 写入 Sandbox 的输入只包含当前已授权 Binding 的稳定 ID、scope、spaceId 与虚拟路径；不传递用户输入摘要、原文、Blob URI、宿主路径、数据库连接、模型密钥或完整 Wiki。
- 动态输出先经固定 JSON envelope 和 Manifest output Schema 校验，数据库仅保存脱敏运行摘要与稳定失败码。

## 3. 受管目录和调用模型

```text
skills/installed/{skillId}/
├── skill.json
└── run.mjs | run.py

skill.run queue
→ builtin dispatcher（仅 wiki-lint）
→ dynamic dispatcher
→ recheck Session / Binding / installation / Manifest / approval
→ create input/artifacts/tmp sandbox
→ write worker-owned binding JSON
→ Linux Bubblewrap CLI
→ output Schema validation
→ completed | failed + redacted audit
```

- `skillId` 必须符合既有小写连字符 ID；动态目录、`skill.json` 与程序文件都必须是常规非符号链接文件/目录，并真实解析在 `skills/installed` 根内。
- `typescript-json-cli` 固定映射为 `run.mjs`，`python-json-cli` 固定映射为 `run.py`。Manifest 不可指定解释器、脚本名、参数、工作目录、环境或网络。
- Manifest digest、SkillRun version/digest、组织安装状态、当前 Binding、成员权限和审批快照在 Worker 认领后全部重新检查；任一变化失败，不启动子进程。
- Worker 不自动把 CLI 输出写为 Artifact，也不把任意输出文本写入 `SkillRun`。本切片只存 runtime、Binding 数、输出类型/计数、耗时、网络调用数 `0` 和模型调用数 `0`。
- 无 Linux Bubblewrap 运行时一律失败关闭；开发机上的单元测试可注入合成 Sandbox 执行器验证领域重核，但不能把它用于实际 Worker。

## 4. 验收

- 固定 `wiki-lint` 仍只走内置 Handler；动态 run 可经 Worker dispatcher 进入动态执行器且不会被内置 Handler 提前标记失败。
- 目录符号链接、Manifest ID/version/digest 漂移、组织停用、撤权、过期/不匹配 approval、超时、无 Linux runtime 与非法结果均进入稳定失败终态，且不保存输入/输出正文或真实路径。
- 合成动态执行器只能收到 Binding 元数据；测试断言 user `inputSummary`、数据库连接、Blob URI 与宿主路径不在 Sandbox input 中。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 通过。Linux 容器另行验证 Bubblewrap 实际子进程、动态安装发现和 Worker 队列。

## 5. 明确后置

- 管理设置页上传/安装第三方 Skill、签名/Publisher、Artifact 发布和配额清理。
- 生成型 `plan-compose`、`practice-generate`、`assessment-generate`、`rubric-grade`，以及模型/网络权限。
- cgroup、seccomp、独立 UID、资源观测和多平台隔离器。
