# Skill 策略与审批 M5-04/M5-05 Spec v1

## 1. 关联计划

- 工作包：`M5-04`、`M5-05`，依赖 `M5-03` 内置 Skill Registry 与 `M5-01/M5-12` 会话/受管知识范围。
- 详细计划：[Agent 对话与学习闭环扩展计划](../plan/agent-learning-expansion-v1.md) 第 2.2、5、6.C、8 节。
- 当前状态：开发中。本切片只完成策略计算、审批记录和 UI；实际第三方 Skill 执行继续等待 `M5-06/M5-07` Sandbox/运行时。

## 2. 目标

- 会话中只发现当前组织启用、且在已绑定知识范围内可合法请求的内置 Skill。
- 为每次需要人工确认的 Skill 建立不可复用的审批记录，绑定版本、digest、输入摘要、会话和范围快照。
- 组织停用、范围不足、会话归档、审批过期或拒绝时，后续运行不得把该记录视为授权。
- `allow`、`ask`、`deny` 是确定性策略结果，不从模型、上传资料或工具输出推断。

## 3. 本轮范围

```text
GET  /api/agent-sessions/{sessionId}/skills
POST /api/agent-sessions/{sessionId}/skill-approvals
POST /api/agent-approvals/{approvalId}/decision

SkillManifest + 组织启停 + 会话范围
→ allow | ask | deny
→ pending | approved | rejected | expired
```

- `allow`：当前权限策略允许将来由 Sandbox 运行；本切片不会执行入口文件。
- `ask`：创建 `pending` 审批；用户可明确批准或拒绝。批准只代表本次拟执行权限，仍需经过未来 Sandbox 的二次检查。
- `deny`：不创建审批、不向 Agent 暴露可执行描述。
- 首批规则：组织停用为 `deny`；`approval: never` 为 `allow`；`conditional`/`always` 为 `ask`。`selected` 必须选择至少一个当前 active Binding，`none` 不得携带范围，`space` 至少有一个 active Binding。

## 4. 审批记录与状态机

```ts
interface SkillApproval {
  id: string;
  sessionId: string;
  userId: string;
  skillId: string;
  skillVersion: string;
  skillDigest: string;
  decision: "ask";
  status: "pending" | "approved" | "rejected" | "expired";
  bindingIds: string[];
  inputSummary: string;
  expiresAt: string;
  decidedAt: string | null;
}
```

| 初始状态                  | 动作                | 目标状态 | 约束                                                                 |
| ------------------------- | ------------------- | -------- | -------------------------------------------------------------------- |
| ask                       | 创建                | pending  | 固定 session、用户、Skill version/digest、范围摘要与 10 分钟过期时间 |
| pending                   | approve             | approved | 只允许会话所有者；仅允许未过期项                                     |
| pending                   | reject              | rejected | 只允许会话所有者；保留记录                                           |
| pending                   | 读取/决定时发现过期 | expired  | 不能再次批准                                                         |
| approved/rejected/expired | 再次决定            | 原状态   | 拒绝重写历史                                                         |

- 输入摘要最长 500 字符，不保存原文、模型提示、Blob URI 或服务器路径。
- `bindingIds` 只能是该会话当前 active binding；不会接受资源 ID、用户目录或任意路径。
- 组织启停和 Manifest 版本在未来执行前必须再次计算；本记录不形成永久或跨版本授权。
- 待确认期间移除 Binding 或撤销空间成员资格时，审批决定会拒绝并标记为 `expired`；用户必须在当前范围内重新请求。

## 5. 安全边界

- 上传资料中的文本不能改变 `allow/ask/deny`、审批状态、范围或过期时间。
- `deny` Skill 不出现在会话发现列表，不创建审批记录。
- 任何 API 均以会话所有者、组织、有效 Session 和 active Binding 重新验证；不可跨用户读取或决定审批。
- 本期不运行 Skill，因此不会访问网络、宿主机、原始文件、数据库直连或入口文件。

## 6. UI

- 对话右栏显示“可用工具与 Skill”：允许项显示“已允许”，需确认项显示“请求确认”，拒绝项不显示。
- 待处理审批显示 Skill、范围数量、输入摘要、过期倒计时和“批准/拒绝”。
- 已批准只显示“待安全运行时接入”，不显示“已执行”或伪造产物。

## 7. 验收标准

- 停用 Skill 后，它不会出现在会话可发现列表，且创建请求返回稳定拒绝码。
- `wiki-correct` 因 `approval: always` 创建 pending 审批；批准记录固定原 digest、范围和过期时间。
- selected Skill 无 active Binding、none Skill 带范围、跨会话 Binding、归档会话、他人审批决定均被拒绝。
- 过期审批不能批准，历史状态不被重写。
- 当前切片不调用 EntryPoint、网络、模型或 Embedding。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e` 通过。

## 8. 后置

- 系统/组织/空间/角色的可配置策略覆盖，及 `conditional` 的细粒度规则。
- Worker 侧 SkillRun、Sandbox、网络限制、产物登记、模型预算与真实执行。
- 管理员代决、多级审批、通知、审批委托和跨进程 Agent 事件重放。
