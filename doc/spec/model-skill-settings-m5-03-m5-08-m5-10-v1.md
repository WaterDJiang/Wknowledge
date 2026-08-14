# 模型与 Skill 管理设置 M5-03/M5-08/M5-10 Spec v1

## 1. 目标

- 为私有化管理员提供独立设置页面，不再要求通过修改 `.env` 接入模型或直接操作 `skills/` 管理 Skill。
- 让模型 Provider 配置真实进入知识问答路由，让 Skill 启停真实影响运行入口。
- 保护模型密钥、限制管理权限并记录配置变更。

## 2. 页面与信息架构

```text
/workspace/settings
├── 模型服务
│   ├── Provider 列表与健康状态
│   ├── 新增 / 编辑 OpenAI-compatible Provider
│   ├── 启用 / 停用
│   └── 连通测试
└── Skills
    ├── 内置 Skill 列表
    ├── 版本、能力与权限摘要
    └── 启用 / 停用
```

- “系统设置”不占用资料、知识、问答和学习组成的主功能菜单；桌面端入口固定在左侧栏底部的用户身份区，以带可访问名称的齿轮按钮进入独立 URL。
- 用户身份区显示头像首字母、姓名和邮箱，让设置入口与当前登录身份形成稳定关联；移动端同时显示“设置”文字，避免只有图标难以识别。
- 设置页数据只在该路由加载。
- 第一切片采用同页双分区，不增加二级路由。

## 3. 权限

- `owner`、`admin`：查看和修改模型与 Skill 配置。
- 其他空间角色：设置 API 返回 403；页面由入口隐藏，直接访问仍由 API 拒绝。
- 配置属于单组织，不绑定单一知识空间；运行时仍按知识空间 `dataPolicy` 做二次约束。

## 4. 模型 Provider

### 4.1 字段

```ts
interface ManagedModelProvider {
  id: string;
  organizationId: string;
  name: string;
  kind: "openai_compatible";
  location: "local" | "cloud";
  baseUrl: string;
  model: string;
  enabled: boolean;
  hasApiKey: boolean;
  timeoutMs: number;
  health: "unknown" | "healthy" | "unhealthy";
  lastCheckedAt: string | null;
}
```

- `baseUrl` 只允许 `http/https` URL。
- 本地 Provider 可以不填 API Key；云 Provider 新建时必须填。
- API Key 加密保存，列表和详情只返回 `hasApiKey`，永不回显原文。
- 编辑时留空 API Key 表示保留原密钥；显式清除密钥不在第一切片提供。
- 第一切片按更新时间选择首个满足能力、启用、健康和数据策略的 Provider。
- 环境变量 Provider 保留为兼容 fallback，但管理页配置优先。

### 4.2 连通测试

- 管理员主动触发 `/models` 合成健康检查。
- 保存 `healthy/unhealthy` 与检查时间。
- 失败只返回稳定错误，不回传 Provider HTTP 正文和密钥。

## 5. Skill 管理

- Skill 定义继续以 `skills/builtin/*/skill.json` 为不可变来源。
- 数据库只保存组织级启用状态，不在线改写 Manifest、digest、权限或入口文件。
- API 返回 Manifest 的版本、描述、能力、权限和限制摘要。
- 首切片允许启停四个内置 Skill。
- 停用 `wiki-query` 后，知识问答接口返回 `SKILL_DISABLED`；其他 Skill 在各自运行入口实施时接线。
- 第三方安装、上传、升级、卸载、Manifest 编辑和签名验证属于后续 M5-03/M5-07。

## 6. 密钥保护

- 使用 `WKNOWLEDGE_CREDENTIAL_KEY` 提供 32 字节 base64url 主密钥。
- 使用 AES-256-GCM 保存密文、IV 和认证标签。
- 缺少主密钥时：允许管理不含密钥的本地 Provider；拒绝保存云密钥。
- 密钥不得进入审计 metadata、API、日志、异常或前端状态。
- 生产环境密钥轮换和多版本解密属于 M7。

## 7. API

```text
GET  /api/settings/model-providers
POST /api/settings/model-providers
PATCH /api/settings/model-providers/{providerId}
POST /api/settings/model-providers/{providerId}/test
GET  /api/settings/skills
PATCH /api/settings/skills/{skillId}
```

- HTTP 输入全部经过 Zod。
- 统一使用 `ApiError`。
- 修改操作追加组织审计事件。

## 8. 数据模型

- `model_provider`：Provider 元数据、加密凭据、健康状态和启停。
- `skill_installation`：组织、Skill ID、版本、digest 和启停。
- Provider 配置与 Skill 状态存 PostgreSQL；Skill Manifest 仍在文件系统。

## 9. 影响面

- `packages/contracts`：设置 API 输入输出 Schema。
- `packages/database`：表与迁移。
- `packages/model-gateway`：从持久化配置建立 Provider。
- `packages/skill-runtime`：发现内置 Skill 与组织启用状态。
- `apps/web`：管理员 API、设置页面、导航和 Query 接线。

## 10. 验收标准

- 管理员可新增无密钥本地 Provider，列表不泄露密钥字段。
- 连通测试更新健康状态；失败不显示原始响应。
- 启用且健康的 Provider 能被 Query API 使用；不满足空间策略时不调用。
- 设置页可查看四个内置 Skill 的权限摘要并启停。
- 停用 `wiki-query` 后问答接口阻止运行，重新启用后恢复。
- 非管理员设置 API 返回 403，未登录返回 401。
- 设置页为独立路由，桌面和移动端无横向溢出。
- 系统设置不出现在主功能导航中；用户身份区的设置按钮具有可访问名称、当前页状态，并能进入 `/workspace/settings`。
- format、lint、typecheck、test、build 和 E2E 通过。

## 11. 后续

- Provider 删除、优先级、fallback 链、费用预算和模型能力选择。
- 密钥轮换、外部 KMS/Vault 和供应商专用 OAuth。
- 第三方 Skill 安装、升级、签名、审批、沙箱和运行历史。
- 组织成员与更细权限设置页面。
