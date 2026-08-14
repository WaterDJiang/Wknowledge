# M7-10-A Agent 会话撤权读取修复 Spec v1

## 1. 关联

- 工作包：`M7-10 安全测试`；对应安全扫描发现 `authorization.agent-session-revocation`（high，CWE-862）。
- 影响面：`packages/core` 会话详情/事件重放、Agent API 错误映射、数据库集成测试。

## 2. 目标

- 用户失去任一 Agent 会话已绑定空间的 viewer 权限后，不得读取该会话的历史回答、Evidence Snapshot、来源引用、标题、ToolCall 或运行事件。
- 新运行的既有撤权重核保持原有行为；本修复补齐历史读取路径，不更改资料、Wiki、会话或证据的不可变记录。

## 3. 规则

- 采用保守拒绝：会话任何 Binding 对应空间当前不可访问时，`getAgentSessionDetail` 与 `getAgentRunEvents` 均返回稳定的撤权错误，不返回部分历史。
- 校验依据为当前 `space_membership`，而非 Binding 的旧 status 或会话创建时权限；不自动恢复/删除历史 Binding。
- 未找到对象/非所有者继续以既有 not found 语义隐藏对象；所有者但已撤权应返回 403 和明确下一步。
- 读取路径不可触发模型、Skill、Worker、Wiki 写入或权限扩大。

## 4. 验收

- 创建带空间 Binding 且含回答/证据/事件的会话后，删除成员关系；详情与运行事件读取均失败，结果中不泄露消息、来源或标题。
- 未撤权时详情与事件重放保持既有返回。
- 其他用户读取仍为对象不存在/无权语义。
- 定向数据库回归与根质量门禁通过。

## 5. 非范围

- 改变 Agent 会话的数据模型、历史证据删除、组织级用户禁用、Provider SSRF、队列租户隔离或生产网络策略。
