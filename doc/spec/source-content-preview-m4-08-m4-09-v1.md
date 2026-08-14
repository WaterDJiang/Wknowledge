# 来源内容与定位预览 M4-08/M4-09 Spec v1

## 1. 关联计划

- 工作包：`M4-08 来源内容 API`、`M4-09 来源预览 UI`。
- 前置：不可变 `ResourceVersion`、`SourceLocator`、空间 RBAC、Local BlobStore 受控读取均已存在。
- 当前状态：开发中；基础原件预览已验证，本增量切片补充音频/视频历史原件播放与 `SourceLocator` 时间段定位，不包含 ASR、字幕或视频理解。

## 2. 用户问题

- 当前“打开来源”仅打开 JSON 定位元数据，用户无法查看原件或确认页码。
- 原件必须按历史 `ResourceVersion` 打开，不能因资料替换转向最新版本。
- 预览必须经空间授权，不能泄露 Blob URI、服务器路径、原始错误或把任意本地文件暴露为 URL。

## 3. 目标与范围

### 包含

- `GET /api/source-locators/content?ref=wk://...`：解析来源、验证资源版本与 `viewer` 权限后，受控返回原始不可变 Blob。
- `GET /workspace/source?ref=wk://...`：显示资料名、历史版本、定位上下文和嵌入预览。
- PDF 使用浏览器原生预览器，并将 `page` 写入嵌入 URL fragment；图片展示原件；Markdown/TXT 展示只读文本。
- 已通过 Worker 媒体探测生成的音频/视频 `SourceLocator` 可以播放其历史原件；播放器加载 metadata 后跳到 `startMs`，到达 `endMs` 时暂停。仅当定位类型与文件 MIME 相符时显示播放器。
- Office、未知 MIME 和暂不支持类型仅提供已授权的下载入口和明确能力状态；不把下载误称为精确预览。
- 查询与 Wiki 的来源链接均改为预览页入口。

### 不包含

- 扫描 OCR、文档结构 node 高亮、表格范围、幻灯片 shape 高亮。PDF bbox 覆盖层由相邻 M4-01/M4-08/M4-09 Spec 接续。
- ASR 字幕、转写节点、关键帧、画面 OCR/描述与“视频理解”结论；归属 M4-05/M4-06。
- 任意 Blob URI、路径、目录或资源 ID 手工输入读取。
- Blob 远程流式适配和 S3 预签名 URL；本切片走已有 Local BlobStore 读取接口。

## 4. API 与安全规则

- `ref` 是唯一输入；服务端用 `parseLocatorRef` 解析，不接受 `path`、`uri`、`file` 或用户提交的 MIME。
- 先登录，再通过 `ResourceVersion → Resource → KnowledgeSpace` 验证 viewer 权限，最后读取 Blob；顺序不可倒置。
- 响应不回显 Blob URI、文件系统根目录、原始异常、堆栈或正文到 JSON 错误中。
- 允许 inline 的只有 `application/pdf`、`image/png`、`image/jpeg`、`image/webp`、`text/plain`、`text/markdown` 与已声明的媒体 MIME；其他类型固定 `attachment`。
- 内容响应设置 `X-Content-Type-Options: nosniff`、私有缓存、受限 CSP 和安全 `Content-Disposition` 文件名；读取失败只返回稳定错误码。
- `SourceLocator` 继续携带 ResourceVersion。预览页面显示版本号和定位上下文，历史引用永远打开当时 Blob。

## 5. 验收标准

- 已授权用户从 Wiki 或问答点击 PDF 页定位时打开独立预览页，嵌入 URL 带对应页码，且显示资料标题与历史版本。
- 已授权用户可读取图片、Markdown/TXT；Office 显示下载而非虚假预览。
- 未登录为 401；无空间权限为 403；错误/未知引用为 400；不存在版本为 404；缺失 Blob 为稳定的 404/503 错误且不泄露路径。
- 原始 Blob URI 不出现在 HTML、JSON 成功响应、错误响应或链接参数中。
- 页面在 390px 和桌面视口不横向溢出；加载、错误、不支持类型均有可理解状态。
- 有效 `audio` / `video` 定位打开同一历史 ResourceVersion 的原件；metadata 就绪后从 `startMs` 播放，到 `endMs` 自动暂停。没有转写或画面理解时，页面明确说明只提供原件播放与时间定位。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 与 `pnpm test:e2e` 通过。

## 6. 后续

- M4-01/M4-10：PDF 页/区域准确率与真实资料抽样评测。
- M4-02/M4-03：Slide、Sheet 定位预览。
- M4-04：图片 OCR bbox。
- M4-05/M4-06：ASR 字幕、转写、关键帧、画面理解与媒体知识节点。

## 7. 当前验证记录

- 已实现并进入自动化门禁：`/api/source-locators/content` 先鉴权和空间 viewer 授权，再按历史 ResourceVersion 受控读取 Local Blob；支持 Range、私有缓存、受限 CSP 与安全下载降级。`/workspace/source` 显示资料名、历史版本与定位上下文；查询/Wiki 来源链接均指向该页面。
- 自动化：未登录 `resolve/content` 均稳定返回 `401 AUTH_REQUIRED`；直接打开来源预览工作台路由回到登录页。`pnpm test:e2e` 为 13/13，完整质量门禁为 104/104 单元/集成、format、lint、typecheck、build 通过。
- 人工验收：使用独立的已构建 Web 服务和短期本地验收会话，成功打开真实 `【定稿】DeepSeek从零到精通20250329.pdf` 的历史版本 V2、第 9 页。iframe 和“新窗口打开”均带 `#page=9`，浏览器原生 PDF 阅读器定位到 9/64 页；对同一受权 URL 的 `Range: bytes=0-31` 返回 `206`、正确 `Content-Range`、`application/pdf` 和 `%PDF-1.7`。桌面及 390px 视口无控制台错误、移动端 `scrollWidth=clientWidth=375`。验收会话已撤销。
- 媒体增量：来源预览组件已实现只读历史原件播放器；媒体 MIME 与 `audio`/`video` 定位类型必须同时匹配，metadata 后从 `startMs` 定位、到 `endMs` 自动暂停。因当前上传准入仍不接收媒体，该 UI 只经合成夹具和组件策略回归验证，尚不标记为人工媒体浏览器验收。
