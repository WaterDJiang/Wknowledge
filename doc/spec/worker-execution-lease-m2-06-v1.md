# M2-06 Worker 执行租约与崩溃恢复

## 目标

让资料处理任务在 Worker 进程异常退出后能安全重新入队，并阻止已失去执行权的旧 Worker 继续写入 compiled、Wiki 或完成状态。

关联工作包：`M2-06`、`M2-11`。

## 范围

- `processing_job` 保存仅内部使用的 `executionToken` 与 `executionLeaseExpiresAt`。
- Worker 以随机执行令牌原子领取 `queued` 任务，或接管已过期的 `processing` / `cancel_requested` 任务。
- Worker 在解析、compiled 写入、Wiki 编译和最终完成前刷新并校验租约。
- `processing_job.stage` 使用 `parsing → compiled_write → wiki_compile → completed` 作为可观察 checkpoint；checkpoint 不是字节级恢复点，重新接管后仍从不可变 raw 重新解析。
- Worker 启动时扫描已过期的执行租约，将非取消任务重新发布到 `resource.process`，并更新内部 queue job ID。
- 旧 Worker 的租约检查失败时停止后续写入，不得把新执行者处理的任务写成 completed/failed。
- 取消语义保持优先：`cancel_requested` / `cancelled` 不因恢复扫描被重新入队。

## 非范围

- 文件解析的字节级断点续传；恢复从不可变源文件重新解析。
- outbox、跨队列事务、死信控制台、批量死信重驱和磁盘不足演练。
- 多 Worker 全局调度、分片上传和资源优先级。

## 状态与不变量

```text
queued --claim(token A)--> processing(lease A)
processing(lease A expired) --claim(token B)--> processing(lease B)
processing(lease expired) --startup recovery--> queued + 新 queue job ID
cancel_requested/cancelled --startup recovery--> 保持取消路径
```

- `executionToken` 不经 API、SSE、审计 metadata 或页面返回。
- 只有持有未过期 token 的 Worker 可以改变 processing job 的阶段、完成或失败状态。
- 恢复重用同一个 ProcessingJob 和 ResourceVersion；不改写 `raw/`，不创建新版本。
- 重新发布失败时保留 `processing` 与过期租约，下一次启动仍可恢复；不伪造 `queued` 成功状态。
- compiled 内容只能先写入 token 独立 staging；发布前再次校验执行租约。校验失败时删除自己的 staging，不替换已发布 compiled。

## 验收标准

- 过期 processing job 被恢复为 queued，得到新的内部 queue job ID，ResourceVersion ID 不变。
- 未过期 processing job 不被另一个恢复程序重新发布。
- `cancel_requested` 与 `cancelled` 任务不被恢复程序重入队。
- 旧 token 的 stage/completed/failed 写入被拒绝，且不覆盖新 token 状态。
- Worker 启动恢复、租约领取和过期接管均有数据库回归测试。
- 黑盒演练使用隔离 pg-boss 队列和临时 Blob/Wiki 根目录：第一个完整 Worker 从队列领取任务后发送 `SIGKILL`，租约过期后第二个完整 Worker 启动恢复并从 raw 重新解析；断言同一 ProcessingJob 与 ResourceVersion 最终 completed，且 compiled 正文来自不可变原件。
- 写入 checkpoint 的测试覆盖：失去执行令牌时不发布 compiled，staging 不残留；正常 owner 才能将 staging 替换为 `compiled/{resourceVersionId}`。
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e` 通过。
