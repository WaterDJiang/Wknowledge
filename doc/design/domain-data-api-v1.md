# 领域数据与 API 设计 v1

## 1. 设计原则

- PostgreSQL 管身份、权限、元数据、状态、审计和学习记录。
- BlobStore 管不可变源文件；Markdown 管知识正文。
- 表、API 和事件名称使用同一领域语言。
- 历史证据使用不可变版本或追加事件，不原地覆盖。
- 所有外键对象访问前重新验证空间权限。

## 2. 领域分组

| 域       | 聚合根          | 主要实体                                          |
| -------- | --------------- | ------------------------------------------------- |
| 身份组织 | Organization    | User、OrganizationMembership、Session             |
| 知识空间 | KnowledgeSpace  | SpaceMembership、DataPolicy                       |
| 资源     | Resource        | ResourceVersion、SourceLocator、Artifact          |
| 任务     | ProcessingJob   | JobAttempt、DeadLetter                            |
| Wiki     | WikiPublication | WikiPageRecord、Review、Conflict、PublishManifest |
| 智能运行 | AgentRun        | SkillRun、ToolCall、Approval、ModelCall           |
| 学习     | LearnerProfile  | Goal、Plan、Course、Question、Attempt、Mastery    |
| 审计     | AuditEvent      | ExportJob                                         |

## 3. 数据库演进目标

### 3.1 当前已有表

`organization`、`app_user`、`organization_membership`、`app_session`、`knowledge_space`、`space_membership`、`resource`、`resource_version`、`processing_job`、`source_locator`、`audit_event`、`learner_profile`、`learning_plan`、`learning_event`、`mastery_snapshot`。

已有不代表领域完成。学习表是骨架，任务、Wiki、Skill 和模型缺少必要记录。

`organization_membership.disabled` 是组织级访问状态；组织管理员只能修改此列。`app_user.disabled` 保留给平台级帐户封禁，不能被组织级 API 写入。

### 3.2 M1–M3 需要新增/调整

| 表                     | 目的                                  |
| ---------------------- | ------------------------------------- |
| user_invitation        | 邀请 token 摘要、角色、过期和状态     |
| resource_upload        | 分片会话、临时 Blob、最终化与完成状态 |
| resource_upload_part   | 每个分片的大小、SHA-256 与临时 URI    |
| storage_reservation    | 组织配额下的上传临时预留与过期回收    |
| processing_job_attempt | 每次领取、阶段、错误和耗时            |
| job_outbox             | 数据库提交后可靠发送队列              |
| wiki_publication       | 空间发布版本、manifest、状态和摘要    |
| wiki_page_record       | 页面 ID、路径、状态、审核和发布版本   |
| wiki_review            | diff、审核人、结论和时间              |
| wiki_conflict          | 冲突事实、来源和裁决                  |
| query_run              | 索引、候选、引用、模型和指标          |

Wiki 正文仍不进入 `wiki_page_record`，表只保存状态和路径。

### 3.3 M5 需要新增

`agent_session`、`agent_message`、`agent_context_binding`、`agent_run`、`tool_call`、`skill_definition`、`skill_installation`、`skill_run`、`approval_request`、`model_provider`、`model_registration`、`model_call`、`artifact`。

- `agent_context_binding` 保存会话、空间、虚拟路径、绑定人、权限快照和状态，不保存宿主机绝对路径。
- `agent_message` 区分 user/assistant/tool/ui，引用当次 AgentRun 和 EvidenceSnapshot；敏感正文按空间策略加密或最小化保存。

### 3.4 M6 需要新增/重构

`learning_goal`、`learning_plan_item`、`course`、`course_module`、`learning_unit`、`learning_unit_content`、`knowledge_point`、关联表、`assessment`、`question`、`question_evidence`、`attempt`、`response`、`grade`、`review_task`、`learning_report`。

- `learning_unit_content` 固定 ResourceVersion/WikiPage/SourceLocator、阅读顺序和完成规则。
- `learning_report` 只保存版本、范围、结构指标、生成状态和 Artifact ID；报告图片由 Artifact 管理。

现有 JSONB 可保留灵活属性，但身份、状态、版本和关联关系必须使用结构化列。

## 4. 版本与删除

- `Resource` 可变名称和可见状态；`ResourceVersion` 不可变。
- Wiki 发布使用递增 publication version；页面路径可变但稳定 ID 不变。
- 学习计划、课程发布、Assessment 和题目发布后创建新版本。
- 默认逻辑删除；真实删除按保留策略、引用检查和审批执行。
- 删除被历史题目或评测引用的资源时，至少保留不可访问普通用户但可审计恢复的历史证据。

## 5. API 分组与目标接口

### 5.1 身份与管理

```text
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me
GET    /api/users
POST   /api/users/invitations
PATCH  /api/users/{userId}
GET    /api/audit-events
```

### 5.2 空间与成员

```text
GET    /api/spaces
POST   /api/spaces
GET    /api/spaces/{spaceId}
PATCH  /api/spaces/{spaceId}
DELETE /api/spaces/{spaceId}
GET    /api/spaces/{spaceId}/members
POST   /api/spaces/{spaceId}/members
PATCH  /api/spaces/{spaceId}/members/{userId}
DELETE /api/spaces/{spaceId}/members/{userId}
```

### 5.3 资源与任务

```text
POST   /api/spaces/{spaceId}/uploads
GET    /api/uploads/{uploadId}
PUT    /api/uploads/{uploadId}/parts/{partNumber}
POST   /api/uploads/{uploadId}/complete
GET    /api/spaces/{spaceId}/resources
GET    /api/resources/{resourceId}
POST   /api/resources/{resourceId}/versions
GET    /api/resources/{resourceId}/versions
GET    /api/jobs/{jobId}
GET    /api/jobs/{jobId}/events
POST   /api/jobs/{jobId}/retry
POST   /api/jobs/{jobId}/cancel
GET    /api/settings/blob-audit
GET    /api/settings/storage-usage
```

### 5.4 Wiki、查询与来源

```text
GET    /api/spaces/{spaceId}/wiki
GET    /api/spaces/{spaceId}/wiki/pages
GET    /api/spaces/{spaceId}/wiki/pages/{pageId}
GET    /api/spaces/{spaceId}/wiki/pages/{pageId}/history
POST   /api/spaces/{spaceId}/wiki/compile
POST   /api/spaces/{spaceId}/wiki/pages/{pageId}/corrections
POST   /api/spaces/{spaceId}/wiki/reviews/{reviewId}/decide
POST   /api/spaces/{spaceId}/query
GET    /api/source-locators/resolve
GET    /api/source-locators/content
```

### 5.5 智能运行与学习

```text
GET    /api/agent-sessions
POST   /api/agent-sessions
GET    /api/agent-sessions/{sessionId}
PATCH  /api/agent-sessions/{sessionId}
POST   /api/agent-sessions/{sessionId}/messages
POST   /api/agent-sessions/{sessionId}/stop
POST   /api/agent-sessions/{sessionId}/context-bindings
DELETE /api/agent-sessions/{sessionId}/context-bindings/{bindingId}
GET    /api/agent-sessions/{sessionId}/events
GET    /api/skills
POST   /api/skill-runs
GET    /api/skill-runs/{runId}

GET    /api/learning-content
POST   /api/learning-plans/generate
POST   /api/learning-plans/{planId}/confirm
GET    /api/learning-units/{unitId}
POST   /api/learning-events
POST   /api/practice/generate
POST   /api/attempts
POST   /api/attempts/{attemptId}/submit
POST   /api/learning-reports
GET    /api/learning-reports/{reportId}
GET    /api/artifacts/{artifactId}
```

- 发送消息返回 AgentRun 与 SSE 地址；长 Skill、报告渲染和题目批量生成返回 202/jobId。
- context binding 输入只接受空间 ID 和可选受管子范围，不接受服务器文件路径。
- M5/M6 实现前为每组接口冻结 Zod Schema、分页和幂等键。

## 6. 通用 API 契约

成功列表：

```ts
interface PageResult<T> {
  items: T[];
  nextCursor?: string;
}
```

错误：

```ts
interface ApiError {
  code: string;
  message: string;
  suggestion?: string;
  requestId: string;
  details?: unknown;
}
```

规则：

- `details` 不能包含堆栈、SQL、绝对路径或敏感正文。
- cursor 绑定稳定排序字段和权限过滤条件。
- 资源创建返回 201；异步任务返回 202；幂等重复可返回 200 并明确 `duplicate`。
- PATCH 使用显式字段 Schema，禁止任意对象透传数据库。
- Blob 巡检是只读健康接口，仅返回脱敏统计、版本标识和 URI 摘要；任何清理动作必须单独建模、审批并写审计。

## 7. 审计事件命名

```text
auth.login_succeeded / auth.login_failed / auth.session_revoked
user.invited / user.disabled / user.role_changed
space.created / space.updated / space.member_changed
resource.uploaded / resource.version_created / resource.deleted
job.retried / job.cancelled / job.failed
wiki.compiled / wiki.published / wiki.reviewed / wiki.conflict_resolved
skill.installed / skill.run_started / skill.run_completed / approval.decided
model.provider_changed / model.call_completed / model.call_denied
learning.plan_confirmed / assessment.published / attempt.graded / grade.reviewed
```

## 8. 迁移规则

- 所有数据库变更通过 Drizzle SQL migration，禁止生产 `push`。
- 新非空列采用 nullable/default → 回填 → constraint 三步。
- 枚举新增可前向兼容；删除/重命名使用新值迁移，不直接破坏旧值。
- API 和 Worker 在滚动升级期间必须兼容新旧 Schema。
- Wiki Schema 迁移独立于数据库迁移，发布清单记录 Schema 版本。

## 9. 验收标准

- API 契约测试覆盖成功、输入错误、401、403/404 和冲突。
- 数据库 migration 可在空库和上一稳定版本数据上执行。
- 删除/版本更新不破坏历史 SourceLocator。
- 写操作均生成审计事件，失败重试不重复业务副作用。
- API 返回不泄露绝对文件路径和敏感配置。
