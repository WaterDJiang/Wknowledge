# M2-04/M2-11 Blob 一致性只读巡检 Spec v1

## 1. 关联计划

- 工作包：`M2-04 事务补偿`、`M2-11 故障测试`，依赖 `M1-07 BlobStore`、不可变 `ResourceVersion` 与组织管理员设置入口。
- 解决“数据库已引用但本地受管 Blob 缺失”与“本地不可变 Blob 没有任何 ResourceVersion 引用”无法被安全发现的运维缺口。

## 2. 目标

- 组织管理员可执行只读巡检，比较本组织 `ResourceVersion.blobUri` 与本地 BlobStore 的不可变文件清单。
- 报告缺失的数据库引用、未引用的本地 Blob、不可检查的非本地 URI 和巡检时的汇总数量。
- 任何巡检请求都不删除、移动、修复、重建或读取原始文件正文；`raw/`、临时分片、已发布 Wiki 与 compiled 不属于巡检删除范围。

## 3. 范围与规则

- 本切片只支持 `local://` URI 与 `LocalBlobStore`；未来 S3 等 Provider 显式计入“未检查引用”，不能误报为丢失。
- 文件清单只遍历 Blob 根目录的常规文件，跳过 `.temporary/`、符号链接和目录；不跟随符号链接。
- 数据库查询必须以 `KnowledgeSpace.organizationId` 限定，管理员不能通过巡检看到其他组织的资源版本或 Blob URI。
- API 只返回 ResourceVersion/Resource 标识、数量及不可逆 URI 摘要；不返回 Blob URI、磁盘路径、原文、堆栈或内部异常。
- “未引用 Blob”只是候选处置线索，不证明可删除。实际清理必须在后续独立保留策略、审批、备份和二次确认工作包中实现。

## 4. 接口与审计

```text
GET /api/settings/blob-audit
```

- 仅组织 owner/admin 可读；未登录为 401，其他角色为 403。
- 本地 BlobStore 或数据库不可用时返回脱敏 `503 BLOB_AUDIT_UNAVAILABLE`。
- 返回 `checkedAt`、引用/库存/缺失/未引用/未检查数量、最多 20 个缺失版本标识和最多 20 个未引用 URI 摘要。
- 读取巡检与现有队列健康读取一致：不生成包含文件信息的审计正文；任何未来清理动作才必须写独立审计事件。

## 5. 验收

- 一个存在 Blob、一个缺失 Blob 和一个未引用 Blob 时，巡检准确分别报告 1/1，`.temporary/` 不计入未引用库存。
- 巡检返回不包含本地根路径、`local://` URI、原始文件内容或其他组织 ResourceVersion。
- 巡检不改变 Blob、ResourceVersion、ProcessingJob、Wiki 或审计表中的任何记录。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 和 `pnpm test:e2e` 通过。

## 6. 非范围

- 自动删除、隔离、恢复或重建 Blob。
- 磁盘剩余空间预检、阈值告警、备份核验和 S3 清单适配。
- 扫描 `data/spaces` 下的 raw、compiled、Wiki、review 或临时发布目录。
