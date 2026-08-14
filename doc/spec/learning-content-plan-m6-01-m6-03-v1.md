# 学习内容选择与计划确认 M6-01/M6-03 Spec v1

## 1. 目标

- 学习者显式选择自己有权访问的不可变 `ResourceVersion`，填写目标后创建学习计划 draft。
- 计划内容快照固定 version、空间、资料名和创建时刻；后续上传新版本不得改变 draft 或 active 计划的依据。
- 用户确认 draft 后才生成 active 计划；旧 active 自动归档，历史计划不被覆盖。

## 2. 范围

```text
GET  /api/learning/content-options
GET  /api/learning/plans
POST /api/learning/plans
POST /api/learning/plans/{planId}/confirm
```

- 首期只选择 ready 状态资料的 ResourceVersion；Wiki 页面、课程范围和 SourceLocator 细化到 M6-04/M6-12。
- `plan-compose` 尚未接模型/Skill：本期由确定性模板生成 draft，明确标记为“待个性化”；不得伪称 AI 已生成。

## 3. 验收

- 无选材、重复版本、无权版本、非 ready 资料均拒绝，不创建计划。
- draft 无法写入学习进度；confirm 后才有唯一 active 计划。
- 确认旧 draft 不会改写计划内容；历史 active 变为 archived。
- 所有 API 重授予空间 viewer 权限，输入使用 Zod。
