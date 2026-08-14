# M7-09 负载基线

本目录只保存合成、无正文的控制面负载说明与结果摘要。不得将真实资料、Cookie、Authorization、Provider 密钥、数据库 URL 或响应正文写入此目录。

## 本机基线命令

先在隔离环境启动 Web，再执行：

```bash
pnpm test:load -- --url http://127.0.0.1:3000/api/health --requests 100 --concurrency 10
pnpm test:load -- --url http://127.0.0.1:3000/api/health/ready --requests 100 --concurrency 10
```

默认只允许 localhost。远程 staging 需要显式传入 URL，且部署环境必须设置 `WKNOWLEDGE_LOAD_ALLOW_REMOTE=true`。远程运行前必须确认使用独立环境、合成数据和授权窗口。

## 2026-08-14 本机结果

| 场景               | 请求 / 并发 | 成功      | P95  | P99  | 吞吐         |
| ------------------ | ----------- | --------- | ---- | ---- | ------------ |
| liveness           | 100 / 10    | 100 / 100 | 30ms | 37ms | 340.39 req/s |
| database readiness | 100 / 10    | 100 / 100 | 47ms | 49ms | 296.24 req/s |

结论：该受管本机服务在上述单端点、只读控制面基线下满足普通 API P95 小于 500ms 的目标。它不能外推为查询首结果、上传、SSE、Worker、模型调用、10,000 资料/50,000 页面或 200 同时在线用户容量；这些需要独立 staging 混合负载报告。
