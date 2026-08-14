# 查询与模型调用记录 M3-11/M5-01 Spec v1

## 1. 目标

- 将每次已进入 Knowledge Agent 的知识问答持久化为可审计运行记录。
- 保存候选证据身份、实际引用、回答模式、模型调用结果、耗时和 `Embedding=0`。
- 在系统设置提供管理员只读运行记录，支持判断查询是否检索、是否调用模型及为何降级。

## 2. 本轮范围

```text
Query API
→ Knowledge Agent
→ QueryRunAudit（无正文）
→ PostgreSQL 原子写入 query_run / query_evidence_candidate / model_call
→ /api/settings/query-runs
→ 系统设置 / 运行记录
```

- 记录成功返回、知识不足拒答、检索摘要降级和模型调用失败。
- 运行记录属于组织，同时关联知识空间和发起用户。
- 管理页面首切片只展示最近 50 条，不提供删除、导出和全文诊断。

## 3. 隐私边界

- 不保存问题原文、Evidence 摘录、模型输入、模型输出和 SourceLocator 原文。
- 问题只保存 SHA-256、字符数；候选只保存 Evidence ID、Wiki 页面 ID/标题/类型、排名、来源数量和是否被引用。
- 模型只保存 Provider ID、模型名、能力、状态、耗时和稳定错误码。
- API 不返回用户邮箱、密钥、模型请求体或异常正文。

## 4. 数据模型

- `query_run`：组织、空间、用户、问题指纹、回答模式、候选/引用数、检索页数、Embedding 次数、总耗时。
- `query_evidence_candidate`：候选顺序、页面身份、来源数和引用状态。
- `model_call`：可选的一次 chat 调用及成功/失败结果。
- `query_run.id` 复用 Agent Run ID；子记录随 Query Run 级联删除。

## 5. API 与 UI

```text
GET /api/settings/query-runs?limit=20
```

- 仅 `owner/admin` 可访问。
- 系统设置新增“运行记录”分区，显示时间、空间、模式、候选/引用、Embedding、模型状态和耗时。
- 无模型调用必须明确显示“未调用模型”，不能显示成成功生成。

## 6. 失败策略

- 运行记录与其候选、模型调用使用同一数据库事务。
- 审计写入失败时 Query API 返回 `QUERY_AUDIT_FAILED`，不把未审计的模型输出作为成功响应。
- Wiki 尚未发布、权限失败或输入校验失败发生在 Agent Run 之前，不创建伪运行记录。

## 7. 影响面

- `packages/contracts`：QueryRunAudit 与管理列表 Schema。
- `packages/database`：三张表与迁移。
- `packages/agent-runtime`：从 Agent Run 构造无正文审计载荷。
- `apps/web`：事务持久化、管理员 API 和运行记录 UI。

## 8. 验收标准

- 有证据查询写入候选及实际引用；无证据拒答写入 0 候选、0 引用。
- 模型成功与失败都可追溯 Provider、模型、状态和耗时；未调用模型不生成伪 `model_call`。
- 每条记录 `embeddingCalls=0`，Schema 禁止其他值。
- 数据库与公共 API 中不出现问题原文、Evidence 摘录或模型输出。
- 非管理员 API 返回 403，未登录返回 401。
- 设置页能看到新查询记录，桌面和移动端无横向溢出。
- format、lint、typecheck、test、build 和 E2E 通过。

## 9. 后续

- Agent session、tool/skill run、artifact 和 approval 的完整 M5-01 数据模型。
- 按空间、用户、状态、Provider 和日期筛选；审计导出与保留期。
- token/费用统计依赖 Provider usage 标准化；首切片不猜测缺失数据。
- 经审批、短期、脱敏的诊断模式。
