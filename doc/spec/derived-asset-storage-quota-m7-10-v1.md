# M7-10-M7 派生产物组织配额 Spec v1

## 1. 关联

- 工作包：`M7-10` 安全复扫；关联 `M2-01/M2-11` 原始 Blob 配额、`M3` compiled/Wiki 发布、`M4` PDF 页图与视频关键帧、`M6-13` 学习报告 Artifact。
- 发现来源：组织容量只汇总 `resource_version` 的原始 Blob。`compiled/` 中的 Markdown、节点、PDF 页图、关键帧以及 BlobStore 中的报告 PNG/PDF 未被计量，合法原件可诱发无界派生产物增长。
- 影响面：PostgreSQL 容量账本与预留、Worker compiled 发布、学习报告渲染；不改变原始文件不可变、历史来源定位、报告事实 JSON 或资源上传协议。

## 2. 目标

- 组织容量同时计算唯一原始 Blob 与已发布的派生产物。
- 编译目录和学习报告在持久化前均按精确字节数预留容量；额度不足时不替换已发布 compiled 内容，不写报告 Blob，并稳定失败。

## 3. 数据与规则

- 新增 `derived_storage_asset`：`organization_id`、稳定 `asset_key`、`byte_size`、创建/更新时间；同一组织同一 key 只有一条当前计量记录。
- `readOrganizationStorageUsage` 的 `usedBytes` 等于去重原始 Blob 与所有派生账本记录之和；未过期 `storage_reservation` 继续计入 `reservedBytes`。
- 编译 key 固定为 `compiled:{spaceId}:{resourceVersionId}`，字节数精确包括 `content.md`、`nodes.json`、`parser-manifest.json` 与受限页图/关键帧资产。重编译同一版本只按新旧大小差额预留。
- 报告 key 固定为 `learning-report:{snapshotId}`，字节数为 PNG 与 PDF 的总和；同一快照只允许同一账本 key。
- 预留失败返回 `STORAGE_QUOTA_EXCEEDED`，不得进入发布替换、报告 Blob 写入或 Provider 调用后的产物保留；预留在失败、租约丢失或超时后释放。
- 发布完成后账本更新与预留释放必须在数据库事务内；Worker 崩溃导致的残留预留由既有过期清理回收。账本领先于磁盘时宁可保守占额，不得低报已发布文件。

## 4. 验收标准

- 现有原始 Blob 配额测试保持通过，并能读取派生账本后的总用量。
- 组织配额不足时，compiled 发布前稳定拒绝，旧发布目录不变且不留下派生账本/预留。
- 同一 compiled key 重编译时，增长部分不足才拒绝；缩小时释放占用并反映新大小。
- 报告 PNG/PDF 的合计额度不足时，BlobStore 不接收任一报告产物，快照进入现有失败态。
- 资源版本、空间或组织不匹配的 key 不可通过调用层伪造；所有调用使用 Worker 已读取的组织与版本对象。
- 数据库迁移、定向回归及全仓质量门禁通过。

## 5. 非范围

- S3 生命周期/实际容量查询、用户删除资源后的派生产物物理回收、跨组织去重、媒体临时目录、Provider 回复大小限制、历史未计量目录的全量回填工具。
