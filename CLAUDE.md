# Wknowledge Claude Code 指南

@AGENTS.md

Claude Code 使用通用规则的唯一来源 `AGENTS.md`。开工时额外读取 `doc/INDEX.md`，只按其指针加载当前 Spec、Plan 和最新 Log。

## Claude 专属规则

- 不在对话中复制整份 Harness；引用文件路径和变更要点。
- 使用 Plan 模式时不修改文件；退出 Plan 后按 `章程/Spec → design → 主计划工作包 → 状态台账 → code → 验收/log` 执行。
- 子 Agent 不得获得高于主 Agent 的工具、文件或网络权限。
