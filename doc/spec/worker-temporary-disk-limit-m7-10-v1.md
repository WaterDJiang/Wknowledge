# M7-10-M5 Worker 临时磁盘限额 Spec v1

## 1. 关联

- 工作包：`M7-10` 安全测试；关联 `M2-11` 存储失败、`M4-07` 媒体解析、`M5-06` Skill Sandbox 与 `M7-10-K` Worker cgroup 聚合资源。
- 发现来源：资源解析、视频转写/关键帧、PDF 页图和报告渲染均在 Worker 的系统临时目录写入中间文件。既有 Compose 仅限制内存、CPU 与 PID，临时文件可占满容器可写层。
- 影响面：生产 Compose Worker 的 `/tmp`；不改变不可变 Blob、Wiki、数据库数据卷或本机 `pnpm worker`。

## 2. 目标

- 为 Compose Worker 提供独立、有限且可覆盖的临时文件系统。
- 临时目录写满时让当前任务显式失败并交由既有 pg-boss 重试/恢复路径处理，不删除原始文件或扩大 Web 进程权限。

## 3. 规则

- `worker` 必须以专用 tmpfs 挂载 `/tmp`，默认容量 `1g`，由 `WKNOWLEDGE_WORKER_TMPFS_SIZE` 覆盖；挂载权限为标准临时目录 `1777`。
- 限额仅适用于 Worker 临时中间文件；`/app/data` 仍是独立、持久化的受管数据卷，不能被 tmpfs 覆盖。
- 不设置临时目录时不得回退到无限制的容器可写层；本机裸机 Worker 的临时盘容量由开发环境管理，不伪造同等隔离。
- 超出限制仍应保留原始失败与既有任务状态/重试语义；不得静默截断解析结果或删除原始证据。

## 4. 验收标准

- Compose 静态回归要求 `worker` 使用 `/tmp` tmpfs、默认 `1g`、专用覆盖变量和 `1777` 权限，并拒绝将数据卷误挂到 `/tmp`。
- `.env.example` 和运维文档说明默认值、覆盖变量及其与 cgroup/Blob 容量边界的关系。
- 基础 Compose 配置解析与根质量门禁通过。

## 5. 非范围

- 单次解析独立容器、按资料动态调整磁盘额度、Kubernetes ephemeral-storage 配额、S3 缓存、真实磁盘耗尽演练、宿主机根盘管理或 Web/gateway 临时盘限制。
