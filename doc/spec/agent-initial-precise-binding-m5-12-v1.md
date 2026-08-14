# Agent 新会话精确知识范围 M5-12 Spec v1

## 1. 关联计划

- 工作包：`M5-01/M5-12`；接续已存在的会话、页面/资料版本/Course Binding、虚拟路径与 Markdown-first ToolCall。
- 计划入口：[Agent/学习扩展计划](../plan/agent-learning-expansion-v1.md) 第 5、6.B、10 节。
- 状态：已验证。

## 2. 问题与目标

现有新会话入口仅能选择知识空间，因此创建时会自动绑定整个空间；用户随后添加指定页面并不会缩小已有整空间 Binding，易造成“选择指定路径但实际仍检索全库”。

本切片要求：

- 用户创建会话时直接选择一个或多个精确 Binding：`space`、`wiki_page`、`resource_version`、`course`。
- 服务端只创建用户提交并通过校验的 Binding；选择子范围时绝不隐式添加同空间 `space` Binding。
- 新会话、所有初始 Binding 与审计必须原子写入；任一个空间、页面、版本或课程失效时不创建半成品会话。

## 3. 契约

```ts
POST / api / agent - sessions;
{
  title: string;
  bindings: Array<{
    spaceId: UUID;
    scope: "space" | "wiki_page" | "resource_version" | "course";
    targetId?: string;
  }>;
}
```

- `bindings` 为 1–8 项；完全相同的 `{ spaceId, scope, targetId }` 拒绝。
- `space` 不接收 `targetId`；其余 Scope 必须由服务端验证其目标身份、所属空间、当前发布/ready/active 状态和用户 viewer 权限。
- `label`、`virtualPath`、检索 filter、数据策略及审计元数据均由服务端生成；请求体不得包含这些字段。
- 创建成功后，首轮 `knowledge.search/read` 只使用这批 Binding；相同空间多个子范围可以共存，但不会自动扩展到整个空间。

## 4. UI

- `/workspace/assistant` 从“空间复选框”改为“创建范围清单”。用户先选空间，再选范围类型和目标，点击“加入本次上下文”。
- 清单展示范围标签、受管虚拟路径和移除按钮；不显示或接受服务器、本机、Blob、raw、compiled、SQL 路径。
- 仅在清单至少有一项且所有子范围已完成选择时允许创建。创建后的会话右栏仍可追加/移除范围。

## 5. 验收

- 创建仅含一个 Wiki 页面 Binding 的会话，数据库和 API 返回中没有同空间整空间 Binding，虚拟路径为该页面路径。
- 跨空间版本、未发布页面、无权限空间、重复 Binding、`../` 和伪造 label/path 均拒绝且不留 session/binding/audit 半成品。
- 同时创建多个同组织范围时，首轮 ToolCall 的 Binding 快照仅包含这些范围。
- 创建页能显示空间、页面、资料版本和课程四类范围，并可在发起创建前移除。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e` 通过。

## 6. 后置

- 已登录真实 Provider 的跨范围自然语言回答质量 E2E。
- 对话中生成型 Skill 的 Linux Sandbox、审批与执行验收。

## 7. 验证记录

- `packages/contracts/tests/contracts.test.ts` 覆盖 1–8 项显式 Binding、重复范围及伪造虚拟路径拒绝。
- `packages/core/tests/agent-sessions.test.ts` 覆盖仅创建指定 Wiki 页面 Binding、没有隐式整空间 Binding，以及无效目标不留下 session 半成品。
- 2026-08-14：定向契约/会话回归 27 项通过；全仓 59 个测试文件、248 项通过；`pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`pnpm build` 通过；Playwright E2E 19/19 通过。
- 自动化 E2E 覆盖新候选范围接口的未登录拒绝和工作台路由；真实 Provider 的已登录自然语言对话仍是后置项，未在本切片宣称完成。
