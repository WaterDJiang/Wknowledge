# Agent 课程知识范围绑定 M5-12/M6-04 Spec v1

## 1. 关联计划

- 工作包：`M5-12` 第四步，依赖已验证的 M6-04 Course/Module/Unit 固定版本快照。
- 上游：[Agent 精确范围](agent-context-subscopes-m5-12-v1.md) 第 8 节、[Agent/学习扩展计划](../plan/agent-learning-expansion-v1.md) 第 2.1、6.B、6.D 节。
- 当前状态：开发中。本切片只支持已确认且当前 active 的 Course，不引入“当前页面”“课程标题搜索”或动态学习计划集合。

## 2. 目标

- Agent 会话可将本人当前 active Course 在指定知识空间内的固定资料版本绑定为一个受管上下文范围。
- 每轮检索在 EvidenceBundle 前仅允许 CourseUnit 快照中、属于该 Binding 空间的 ResourceVersion；同空间的后来上传资料或其他课程资料不得进入回答、模型上下文、Skill 范围或来源快照。
- 用户只能选择服务端列出的已授权 Course；虚拟路径、范围标签和资源版本 filter 均由服务端生成。

## 3. 数据与 API 契约

新增 Binding 范围：

```ts
type AgentContextScope = "space" | "wiki_page" | "resource_version" | "course";

interface AgentContextBinding {
  scope: "course";
  targetId: string; // Course UUID
  spaceId: string; // Course 内该空间的固定资料子集
  virtualPath: `/knowledge/${spaceId}/courses/${courseId}`;
}
```

- 客户端仅提交 `{ spaceId, scope: "course", targetId: courseId }`；拒绝 `label`、虚拟路径、资源版本数组、课程标题、`..` 和任意真实路径。
- 一个跨空间 Course 可在不同空间各绑定一次；同一 `{sessionId, spaceId, courseId}` 不可重复。
- `GET /api/agent-sessions/{sessionId}/context-options?spaceId=...` 增加本用户当前 active Course 中、该空间可用的候选。
- Binding 保存 Course ID；资源版本子集每轮从已固定的 CourseUnit/ResourceVersion 重新解析，不写入客户端可篡改字段。

## 4. 核心规则

- 创建与运行时均验证：Course 属于该用户的 active LearningPlan、Course 状态为 active、至少有一个 CourseUnit 的 ResourceVersion 位于 Binding 的 spaceId，且用户仍是该空间成员。
- 运行时生成的 `resourceVersionIds` 必须来自 CourseUnit 固定快照，而非 Resource 当前版本、资源名称或 Course UI 状态；Course 不可用或其空间子集为空时 Binding 标为 `revoked`。
- Course scope 的 Evidence filter 与 `resource_version` scope 同样在 Markdown-first 检索评分、模型调用与持久化之前执行。Embedding 调用保持 0。
- 已存在的 Agent Run、EvidenceSnapshot、SkillApproval 和 SkillRun 不被 Course 更新、撤权或 Binding 移除改写；它们只保留既有安全元数据。
- Course 范围不读取计划用户声明、学习事件、Attempt、Grade、答案键、原文 Blob 或其他学习者记录。

## 5. 验收

- 同一空间内有课程快照资料与后续上传资料，绑定 Course 后查询只返回课程快照资料的 Wiki 页面和 SourceLocator。
- 一个跨空间 Course 只在绑定的空间内检索其对应 ResourceVersion；跨空间资料和同空间非课程资料不越界。
- 伪造 Course ID、其他用户 Course、已归档 Course、错空间 Binding 和无成员权限均拒绝，且不能降级为整个空间。
- 撤销成员资格、计划/课程失效或删除 Binding 后下一轮不读取该范围；历史快照不写入正文。
- 自动化覆盖服务端选择、运行时重核、filter、撤权与 API 未登录；全仓质量门禁通过。

## 6. 后置

- CourseUnit 细粒度 Binding、课程专用 `knowledge.list/search/read` ToolCall 快照和跨进程事件重放。
- `plan-compose`、`practice-generate` 等生成型 Skill；它们必须独立保存 SkillRun/version/digest，且不得直接改写 Course、Attempt、Grade 或计划状态。
