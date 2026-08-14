# 幻灯片 Shape 与备注精确回源 M4-02 Spec v1

## 1. 关联计划

- 工作包：`M4-02`，依赖 M2-08 `CompiledNode`、M4-08/M4-09 授权来源预览与不可变 `ResourceVersion`。
- 状态：已验证。本切片只提取 PPTX 中的文本 Shape、表格单元格文本和备注为可回查证据；不渲染 Office 原件、不执行宏、不进行图片 OCR 或视觉理解。

## 2. 目标

- 每段从 Shape 提取的文字都记录同一 PPTX 历史版本、slide 序号和稳定的 `shapeId`。
- 每页备注以 slide 范围节点保存，和 Shape 内容明确区分。
- 来源页只能读取已发布的指定 slide/shape 派生文本；原始 PPTX 继续以受权下载提供。

## 3. 解析规则

```text
PPTX → slide n → text/table Shape → slide + shapeId Locator
                 → notes text       → slide Locator
```

- 只读取 `python-pptx` 暴露的文本框、占位符与表格单元格文字；图片、嵌入对象、图表、公式、外链、宏和动画不解释。
- `shapeId` 使用 PPTX 内 Shape 的数值 ID 字符串；不能由文件名、文本或用户输入生成。
- 单个 Shape/备注最多 32 KiB UTF-8 文本，超过时截断并在元数据标记；空 Shape/空备注不生成节点。
- 同一 slide 没有文本 Shape 但有备注时仍生成备注节点；相同 slide 内 node 顺序稳定。

## 4. 来源预览

- 新增只读 `slide-preview` API，根据 `wk://source` 权限重核并从同一版本的已发布 `nodes.json` 读取。
- 带 `shapeId` 的定位只返回该 Shape；仅 slide 定位返回该页所有 Shape 与备注，不能回退其他幻灯片或版本。
- UI 显示“幻灯片文字/备注”派生预览和定位标签；不将文字预览伪装成原始版式或图片内容。

## 5. 验收标准

- 多页 PPTX 的文本框、表格和备注产生合法 SourceLocator；每个 Shape/备注节点关联同一不可变版本。
- 请求指定 Shape 时只得到该 Shape；请求不存在 Shape、slide 或跨空间版本稳定拒绝。
- 图片 Shape、图表或空 Shape 不会产生虚构文本或视觉描述；超长内容有明确截断标记。
- Parser、范围选择、API/UI 与根质量门禁已通过；真实登录态 PPTX 上传、Wiki 编译和来源页点击流仍待可复用安全会话验收。

## 6. 明确后置

- 幻灯片图片 OCR、截图/原版式渲染、Shape 高亮叠层、图表数值解析、备注编辑和 PowerPoint 在线编辑。
