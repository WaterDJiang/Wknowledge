# Wiki 黄金集评估 M3-12 Spec v1

## 1. 目标

- 建立可重复运行、可版本化、可比较的 Markdown Wiki 查询评估框架。
- 输出 Recall@10、引用准确率、来源定位准确率、拒答准确率、Embedding 调用数和失败样例。
- 先用受控试点集验证评估工具，再导入 100 份真实资料和 50+ 人工问题执行 M3 退出门禁。

## 2. 数据集契约

```text
eval/wiki/golden-v0.1.json
├── metadata：版本、阶段、说明
├── documents：固定 ResourceVersion、编译模式和标准节点
└── questions
    ├── question / language / questionType
    ├── expectedPageIds
    ├── expectedResourceVersionIds
    ├── expectedSourceRefs（正式人工标注）
    └── expectRefusal
```

- 试点集使用固定 UUID，确保 Wiki 页面 ID 和来源身份可复现。
- 正向问题必须至少声明一个预期页面和一个预期资源版本。
- 拒答问题不得携带预期页面或资源版本。
- 资料、问题和预期答案位于同一版本文件；Runner 只把 documents 交给 Wiki，不把预期答案传入检索实现。

## 3. 指标

- `Recall@10`：正向问题 Top 10 中至少命中一个预期页面的比例。
- `Citation accuracy`：正向问题返回的引用中，页面属于预期页面且全部 SourceLocator 指向预期资源版本的比例。
- `Source locator accuracy`：带人工来源标注的正向问题中，每条返回证据至少携带一个已标注精确 SourceLocator 的比例。
- `Refusal accuracy`：拒答问题中正确返回空 EvidenceBundle 的比例。
- `Answerable accuracy`：正向问题中没有错误拒答的比例。
- `Embedding calls`：所有问题的总调用数，必须为 0。
- 所有指标同时按语言、问题类型分组；首切片至少输出总体结果与失败样例。

## 4. 命令与产物

```bash
pnpm eval:wiki
pnpm eval:wiki -- --dataset eval/wiki/golden-v0.1.json --output /tmp/wiki-eval.json
pnpm eval:wiki -- --dataset /secure/blind.json --review /secure/blind.review.json --formal
```

- 默认输出人类可读摘要和 JSON 结果，不写入开发数据库。
- Runner 使用临时空间、正式 Compiler 和正式 `queryWikiEvidence`，运行后清理。
- 非法数据集、重复 ID、页面预期不存在或指标未达本数据集阈值时命令退出 1。
- `--formal` 必须使用 approved blind Review Manifest、100+ 资料、50+ 问题和逐题来源标注；治理规则见 `wiki-golden-governance-m3-12-v1.md`。

## 5. 试点集边界

- `golden-v0.1` 是评估基础设施试点，不是 M3 正式验收集。
- 试点目标：至少 6 份资料、12 个问题，覆盖知识/案例/资料、中文/英文、可回答/拒答。
- 试点阈值用于阻止评估框架回归，不替代正式门禁 `100 份资料、50+ 问题、Recall@10 ≥ 85%`。
- 试点问题可见，属于调试集；正式验收必须增加独立盲测分片和人工审核记录。

## 6. 影响面

- `packages/contracts`：黄金集数据、单题结果和评估报告 Schema。
- `packages/wiki`：评估 Runner 与 CLI。
- `eval/wiki`：版本化试点数据和 README。
- 根命令与 Harness：评估命令真实存在后登记 `pnpm eval:wiki`。

## 7. 验收标准

- 相同数据集重复执行得到相同命中、引用和拒答结果；时间字段除外。
- Runner 确认每个预期页面真实存在，SourceLocator 可以解析且关联预期 ResourceVersion。
- 报告列出每个失败问题、实际页面、预期页面和失败原因，不只给平均分。
- 试点集满足自身阈值，Embedding 总调用数为 0。
- 无数据库、无网络依赖；临时文件运行后清理。
- format、lint、typecheck、test、build 通过。

## 8. 正式验收关闭条件

- 100 份真实资料完成版本化、授权和去敏审查。
- 50+ 问题由资料作者或领域审核者标注页面及 SourceLocator。
- 调试集与盲测集分离；修正预期必须留审核记录。
- 正式报告 Recall@10 ≥ 85%，引用与拒答指标达到项目章程目标。
