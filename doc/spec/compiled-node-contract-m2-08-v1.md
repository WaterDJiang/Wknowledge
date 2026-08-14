# CompiledNode v1 标准节点契约 Spec

## 1. 关联计划

- 工作包：`M2-08 标准节点`。
- 上游：`M2-03 ResourceVersion`、`M2-09 基础解析`。
- 下游：`M3-01/M3-03/M3-10` 长资料拆页与查询，`M4-05/M4-06` 音视频时间节点。

## 2. 问题

- 当前 `CompiledNode` 只有 `id/title/content/locator/tags`，没有类型、顺序、层级和扩展元数据。
- `nodes.json` 虽声明 `schemaVersion: 1`，但未经共享 Schema 校验，也没有 ResourceVersion 顶层绑定。
- 设计中的 `parser-manifest.json` 未生成，无法追溯解析器与版本。
- Worker 对 Python stdout 使用 TypeScript 类型断言，运行时不会拒绝错误节点。

## 3. 目标契约

```ts
interface CompiledNode {
  schemaVersion: 1;
  id: string;
  kind: "heading" | "paragraph" | "table" | "image" | "slide" | "transcript";
  title?: string;
  content: string;
  parentId?: string;
  order: number;
  locator: SourceLocator;
  metadata: Record<string, unknown>;
}

interface CompiledDocument {
  schemaVersion: 1;
  resourceVersionId: string;
  nodes: CompiledNode[];
}

interface ParserManifest {
  schemaVersion: 1;
  parserId: string;
  parserVersion: string;
  runtime: "node" | "python";
  mimeType: string;
  resourceVersionId: string;
  generatedAt: string;
}
```

## 4. 不变量

- 节点 ID 在同一 ResourceVersion 和同一解析器版本内稳定，不使用随机数或时间戳。
- 节点 ID 唯一；`parentId` 必须引用同文档中已存在的节点，不得自引用。
- `order` 为非负整数且在同文档唯一，父节点必须早于子节点。
- 所有节点 Locator 和 ParserManifest 都必须指向 CompiledDocument 的 `resourceVersionId`。
- 空内容不入库；解析器不生成无来源节点。
- 上传文档内容仅是不可信数据，不会从 metadata 变成运行时指令。

## 5. 兼容边界

- 新 Worker 只写入正式 v1 `nodes.json` 和 `parser-manifest.json`。
- 旧原型节点可通过确定性归一化补全 `kind/order/metadata/schemaVersion`；不改写原文件。
- 归一化不猜测标题层级，默认为 `paragraph`；后续重新解析时由对应 Parser 生成更精确节点。
- Wiki Frontmatter Schema 本轮不变，不触发已发布 Wiki 迁移。

## 6. 实施范围

### 包含

- `packages/contracts` 提供 CompiledNode、CompiledDocument 和 ParserManifest Zod Schema/类型。
- 契约校验唯一 ID、order、parentId 和 ResourceVersion 一致性。
- Worker 在写入和 Wiki 编译前验证 Node/Python 解析结果。
- TXT/Markdown/CSV/PDF/DOCX/PPTX/XLSX 输出 v1 节点。
- 原子写入 `content.md`、`nodes.json` 和 `parser-manifest.json`。
- 旧原型节点归一化单元测试。

### 不包含

- Wiki material/topic/concept 拆页，归属 `M3-01/M3-03`。
- PDF bbox、DOCX 表格/图片、PPTX Shape 和 XLSX 公式精确定位，归属 M4。
- OCR、ASR、视频关键帧和模型接入。
- 自动重写已存在的 compiled 目录。

## 7. 影响面

- 共享契约、Wiki 编译输入、Worker 解析和 Python CLI JSON 输出。
- `compiled/{resourceVersionId}` 新产物结构。
- 不改数据库 Schema、API 路由、用户权限和前端页面。

## 8. 验收标准

- 合法的多层节点通过 Schema；重复 ID/order、未知 parent 和跨版本 Locator 被拒绝。
- 旧原型节点经归一化可被正式 Schema 读取。
- Python CLI 输出不符合 Schema 时 Worker 在写盘前失败。
- 新处理文件同时产生可校验的 `nodes.json` 和 `parser-manifest.json`。
- 重复解析同一文件时节点 ID、kind、parentId、order 和 Locator 不变。
- 既有 Wiki 查询和回源回归测试通过，Embedding 调用保持 0。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 通过。
