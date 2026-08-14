# PDF 原生文字区域预览 M4-01/M4-08/M4-09 Spec v1

## 1. 关联计划

- 工作包：`M4-01`、`M4-08`、`M4-09`，接续已验证的 PDF 原生文字 bbox、不可变来源和受权原件预览。
- 状态：已验证。本切片只将已解析的原生文字 bbox 叠加在同版本的派生 PDF 页图上；不新增 OCR、表格/版式理解或模型调用。

## 2. 目标

- 让 `pdf + page + bbox` 来源可直接看见对应历史页和记录区域，而不只是跳转到浏览器 PDF 页码。
- PDF 页图在 Worker 处理阶段生成并与 `nodes.json` 同步原子发布；Next.js 只授权读取已发布派生图和已验证的 bbox。

## 3. 数据流

```text
受管 local:// PDF → Python Parser 原生文字 bbox
→ Worker 固定 PyMuPDF CLI 生成 page-###.png
→ compiled staging/assets/pdf-pages/*.png + page manifest
→ 原子发布
→ 受权 PDF 区域 API → 浏览器页图 + bbox 覆盖层
```

- 仅处理最多 200 页、256 MiB 的 PDF；每页 PNG 最多 8 MiB，固定 144 DPI、最长边不超过 2,048 px。
- 页图资产路径固定为 `pdf-pages/page-###.png`，只由 Worker 生成；用户不得指定页码、路径、DPI、文件名或渲染器参数。
- 页图 manifest 记录页码、`width`、`height` 与 `pdfPointWidth`、`pdfPointHeight`。前端按这些比例将 bbox point 坐标映射到 CSS 百分比。
- 区域 API 的唯一输入仍是 `ref=wk://source/...`；服务端先验证历史版本、空间 `viewer` 权限、已发布 PDF 节点与其 bbox，再读取对应派生页图。

## 4. 失败与安全

- 超页数、超文件大小、PyMuPDF 失败、空/超限页图或损坏 page manifest 不发布任何页图；原有 PDF 原件预览与 Wiki 文本节点仍可继续发布。
- Worker CLI 不访问数据库、不调用网络或模型，不接收用户命令；原始 PDF、页图和文字内容均为不可信数据，不能成为 Agent/Skill 指令。
- API 不泄露 Blob URI、compiled 路径、Python 失败输出或任何其他页/版本；无页图或无精确 bbox 返回稳定 404。

## 5. 验收

- 合成双页 PDF 的 page-1 PNG 与 manifest 可被验证，bbox 覆盖层按 point 页宽高映射并保持在图内。
- 非 PDF、没有 bbox、错页、错版本、未登录与无空间权限分别稳定拒绝；历史版本只能读取自身页图。
- 列表/页面读取不在 Route Handler 生成 PNG；派生页图只经 Worker staging 原子发布。
- 页面显示“已记录原生文字区域”，不声称 OCR、表格、视觉理解或人工定位准确率；点击/查看不写学习进度。
- 全仓格式、Lint、类型、测试、构建与 E2E 门禁通过。

### 验证记录

- 受管 Worker 页图、区域比例映射与原子发布定向回归：4 个文件、11 项通过。
- 根质量门禁：`pnpm format:check`、`pnpm lint`、`pnpm typecheck` 通过；数据库全量 `pnpm test` 为 59 个文件、245 项通过；`pnpm build` 通过；`pnpm test:e2e` 为 19 项通过，包含 PDF 区域 API 的未登录拒绝。
- 首次受限环境的数据库全量测试报 `connect EPERM 127.0.0.1:5432`；原因是本地 PostgreSQL 连接被沙箱禁止。在允许项目本机数据库连接的同一命令下全量通过，不是产品断言失败。

## 6. 后置

- 扫描 PDF OCR、复杂版式/表格区域、可选手工标注、多个区域高亮、真实 PDF 95% 抽样准确率和页内文本选择。
