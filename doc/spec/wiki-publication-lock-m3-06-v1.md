# Wiki 空间发布锁与 Manifest M3-06 Spec v1

## 1. 关联计划

- 工作包：`M3-06 发布协议`，依赖 M3-03 编译器及现有审核/冲突原子发布。

## 2. 目标

- 同一空间的编译、审核、提案接受和冲突裁决跨进程串行发布。
- 每次发布写可校验 manifest；崩溃后可识别未完成 staging 并安全恢复。

## 3. 方案

- PostgreSQL `wiki_publication_lock` 以 `space_id` 为主键，记录 owner token、lease expiry、operation 和 heartbeat。
- 原子插入或只在旧 lease 过期时接管；未获得锁返回 `WIKI_PUBLICATION_LOCKED`，Worker 退避重试，HTTP 写操作返回 409。
- 释放必须匹配 owner token；长操作 heartbeat，绝不释放其他进程租约。
- 心跳间隔必须不晚于有效租约的一半；测试或故障演练使用短租约时同样适用。并行测试使用的租约必须为调度与数据库往返留出足够余量，不能把主机瞬时负载误判为租约逻辑失败。
- 任一 heartbeat 失去 owner 身份时，包装器必须以 `WIKI_PUBLICATION_LEASE_LOST` 失败返回；其 finally 释放不得删除接管者的锁。
- staging 生成 `publish-manifest.json`，含 publishId、操作、页面摘要和状态；Lint 后更新为 published 并原子替换 `wiki/`。
- Worker 启动时扫描受管数据根目录下同时存在于 PostgreSQL 的空间 UUID，并在每次持锁编译前再次恢复已过期的 `.wiki-staging-*` / `.wiki-backup-*`；若发布中断且 `wiki/` 缺失，只恢复最新 backup，不触碰 raw、compiled、reviews。

## 4. 验收

- 包含 Drizzle Schema/迁移、含 heartbeat 的 Lock Repository、Worker/API 包装、manifest、恢复和并发测试。
- 不包含 Redis、分布式文件锁、跨空间全局锁和自动回滚已成功发布版本。
- 两个并发发布只有一个进入临界区；租约过期可接管；错误释放不影响后继请求。
- 短租约的长临界区持续心跳，其他 owner 不能提前接管；模拟 owner 被替换后调用以 lease-lost 失败且接管锁保留。
- staging/Lint/rename 失败后已发布 Wiki 保持可读，下一次可安全恢复。
- Worker 启动恢复能修复没有待处理资源的已中断空间，且不会遍历或修改非空间目录。
- `pnpm db:migrate`、并发集成测试和完整质量门禁通过。
