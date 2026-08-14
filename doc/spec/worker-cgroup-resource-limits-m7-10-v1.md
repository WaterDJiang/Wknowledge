# M7-10-K Worker cgroup 聚合资源限制 Spec v1

## 1. 关联

- 工作包：`M7-10` 安全复扫；关联 `M2-06` 任务韧性、`M4-07` Python 解析运行时、`M5-06` Skill Sandbox。
- 发现来源：2026-08-14 安全扫描。动态 Skill 的 `--rlimit-as` 只约束单个进程地址空间；Compose Worker 没有容器级 memory/CPU/PID 上限，合规但昂贵的解析/转写或多个子进程仍可耗尽共享 Worker。
- 影响面：生产 Compose Worker、部署运维文档与静态 Compose 回归；本地裸机 `pnpm worker` 不改变。

## 2. 目标

- Compose Worker 以明确、可覆盖的容器 cgroup 内存、CPU 和 PID 限额运行。
- 不影响 Web/PostgreSQL 资源配置、业务队列/重试语义或动态 Skill 单进程限制。

## 3. 规则

- `worker` 必须声明 `mem_limit`、`cpus` 与 `pids_limit`，默认分别为 `2g`、`2.0`、`256`，可用专用 `WKNOWLEDGE_WORKER_*_LIMIT` 环境变量覆盖。
- Worker 内存不足或 PID 用尽时，由容器运行时终止/重启；pg-boss 既有租约与重试恢复任务，不在 Web 请求进程中回退执行。
- 生产部署必须按节点容量、并发和媒体模型调优，不得把默认值视为部门级压测结论。

## 4. 验收标准

- Compose 解析结果保留三项 Worker 限额；静态回归拒绝缺失、错误服务或不安全空值。
- 基础/开发 Compose 配置验证通过。
- 运维文档说明默认值、覆盖变量和 cgroup 与单进程 `--rlimit-as` 的关系。
- 全量质量门禁通过。

## 5. 非范围

- 单次解析独立容器、临时磁盘配额、GPU 配额、Kubernetes LimitRange、自动扩缩容、真实 OOM 演练或调整 pg-boss 并发策略。
