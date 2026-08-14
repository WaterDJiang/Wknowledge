# 学习者自述画像 M6-02 Spec v1

## 1. 目标

- 学习者可维护当前基础、每周可投入时间、学习节奏和补充说明，作为学习计划候选的受控输入。
- 用户自述（declared）、系统观察（observed）和 AI/规则推断（inferred）严格分列；本切片只允许用户修改 declared。
- 每次画像更新追加 LearningEvent；创建计划时把当时声明复制为计划快照，可审计地说明候选使用的是用户何时保存的声明。

## 2. 范围

```text
GET /api/learners/me
PUT /api/learners/me
```

- 计划草稿继续由确定性模板创建；本期仅在界面说明画像将用于后续个性化候选，不能伪称已被模型使用。
- 不实现 AI 推断、确认/否定推断、观察数据编辑或跨用户比较；这些属于 M6-02 后续与 M6-11。

## 3. 验收

- 未登录的读取和写入请求返回 401；写入接受 Zod 校验与同源保护。
- 用户只能读取和修改自己的 declared；observed/inferred 不随本接口改写。
- 更新后刷新返回一致声明，并增加一条 `learner_profile.declared_updated` 学习事件；之后修改画像不改写既有 LearningPlan 的 declared 快照。
- 无计划、模型、Skill 或外部网络调用；用户说明不会被当作 Agent 指令执行。
