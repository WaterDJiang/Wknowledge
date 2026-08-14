# Wiki 黄金集

- `golden-v0.1.json`：6 份受控资料、12 个问题的 Runner 试点集。
- 用途：验证数据契约、Compiler/Query 接线、指标、失败报告和 Embedding=0。
- 限制：不是 100 份真实资料正式验收集，不得用于宣称 M3 Recall@10 门禁完成。
- `pilot` 可无人工来源定位标注；正式 `development` / `blind` 数据集必须另附不含敏感正文的 Review Manifest。

运行：

```bash
pnpm eval:wiki
pnpm eval:wiki -- --dataset eval/wiki/golden-v0.1.json --output /tmp/wiki-eval.json
pnpm eval:wiki -- --dataset /secure/development.json --review /secure/development.review.json
pnpm eval:wiki -- --dataset /secure/blind.json --review /secure/blind.review.json --formal
```

`--formal` 只接受 approved blind 清单，且强制 100 份资料、50 个问题、资料授权/去敏复核引用和逐题 SourceLocator 人工标注。授权原件、去敏说明和盲测标签不进入仓库、浏览器或业务数据库。
