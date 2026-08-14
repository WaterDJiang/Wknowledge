# Wiki 黄金集治理与正式盲测门禁 M3-12 Spec v1

## 1. 关联计划

- 工作包：`M3-12 黄金集`。
- 基础设施：[Wiki 黄金集评估 Spec](wiki-golden-evaluation-m3-12-v1.md)。
- 当前状态：开发中；本切片交付正式数据的治理契约和机器门禁，不宣称已拥有 100 份真实资料。

## 2. 目标

- 把正式 `development` 与 `blind` 数据集的授权、去敏、人工问题标注和复核记录变成可校验对象。
- 让正式评估同时验证页面、ResourceVersion 和 `SourceLocator`，而不是仅凭文档版本推定引用正确。
- 阻止把试点、合成数据、未审批标签或可见调试集当作 M3 退出门禁证据。

## 3. 范围

### 3.1 数据集与复核清单

- Dataset 继续只保存可编译的受控节点和问题，不保存原始文件、完整授权文本、用户身份或敏感正文。
- 正式数据的独立 `WikiGoldenReviewManifest` 保存数据集 SHA-256、阶段、状态、去敏后的授权引用 ID、去敏复核 ID、标注者/复核者代号和时间。
- 每一个文档与每一个问题都必须在清单中恰好有一条复核记录；问题复核记录固定预期页面、资源版本和 `wk://source/...` 来源定位引用。
- 授权原件与敏感复核说明保存在受控线下或私有凭据系统；仓库只保留不可逆的引用 ID。

### 3.2 命令

```bash
pnpm eval:wiki -- --dataset eval/wiki/golden-v0.1.json
pnpm eval:wiki -- --dataset /secure/development.json --review /secure/development.review.json
pnpm eval:wiki -- --dataset /secure/blind.json --review /secure/blind.review.json --formal
```

- 普通运行允许 `pilot`，用于回归评估基础设施。
- `--formal` 只能接受 `blind` 数据集，且必须包含已批准的复核清单、100 份以上资料、50 个以上问题、逐题来源定位标注和正式阈值。
- `--formal` 不接受 `pilot`、`development`、合成资料、`draft/revoked` 清单、摘要不匹配、覆盖不完整或盲测标签缺失的数据。

## 4. 规则

- Dataset 的 SHA-256 使用键排序、数组顺序保留的 canonical JSON；同一内容在格式变化后得到同一摘要。
- `expectedSourceRefs` 是标注的精确来源定位集合。可回答问题必须至少有一页、一个资源版本和一个来源定位；拒答问题三者均为空。
- 评估结果的 `citationCorrect` 要求候选页面和来源版本正确；`sourceLocatorCorrect` 还要求每条返回证据至少包含一个标注的来源定位。
- 任何资料或题目复核被撤销后，`--formal` 必须失败，不可使用旧报告继续宣称通过。
- `blind` 的标签文件不进入公开调试集、演示材料或客户端构建产物；运行账户按最小权限读取。

## 5. 验收标准

- 无 Review Manifest 的 `--formal` 失败；错误能说明缺失的是清单、审批、摘要、覆盖、阶段还是数据量，且不输出原始敏感内容。
- 数据集字段重排后摘要不变；语义改变后摘要不同。
- 不完整文档/题目复核、错误摘要、重复复核、错误来源定位和 `development` 阶段均不能通过正式门禁。
- 已批准的合格测试夹具能通过相同的 Formal Gate 逻辑；实际 M3 退出仍严格要求用户授权的 100 份真实资料和 50+ 人工问题。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 通过。

## 6. 非范围

- 不在仓库生成、猜测或伪造真实资料的授权与标注记录。
- 不将盲测标签上传至浏览器、业务数据库或 Markdown Wiki。
- 不改变 Markdown-first Query，不引入 Embedding、向量数据库或外网评估服务。
