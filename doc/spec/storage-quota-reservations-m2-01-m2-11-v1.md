# M2-01/M2-11 组织存储配额与预留 Spec v1

## 1. 关联计划

- 工作包：`M2-01 上传协议`、`M2-04 事务补偿`、`M2-11 故障测试`。
- 补齐“上传前配额判断”缺口；不取代操作系统 `ENOSPC`/`EDQUOT` 的运行时错误处理。

## 2. 目标

- 每个组织拥有可配置的容量上限，首期默认 `1 GiB`。
- 实际占用按该组织所有 `ResourceVersion` 的唯一 `blobUri` 计量，复用同一不可变 Blob 不重复计费。
- 分片上传会话从创建开始按完整申报大小预留容量；`open`/`finalizing` 未过期会话均占用预留。
- 直接上传与会话创建在 Blob 写入前完成事务预留；同组织并发操作不能仅靠同时读总量绕过上限。
- 成功持久化为 ResourceVersion 后释放预留并由实际 Blob 占用接替；重复/失败/过期会话不长期占用配额。

## 3. 规则

- 配额判断公式：`唯一不可变 Blob 字节数 + 未过期 reservation 字节数 + 本次新增预留 ≤ quotaBytes`。
- 每次预留锁定组织记录，并在同一事务读取用量、创建 reservation；同一组织的竞争请求串行判定。
- 直接上传/替换只有将写入新 Blob 时预留；命中既有同空间可用 Blob 的版本复用不重复预留。
- 分片会话无论最终是否命中重复资料，都必须预留完整申报大小，因为临时分片本身会占用受管存储；成功或重复最终化后释放。
- 崩溃、网络中断或过期会话的 reservation 以 `expiresAt` 自动失效于配额计算；Worker 会清理过期 `open` 与终态 `failed` 会话的已记录临时分片，`finalizing` 会话仍保留给最终化重试。
- 超限错误码为 `STORAGE_QUOTA_EXCEEDED`，HTTP 为 `507 Insufficient Storage`；响应不返回组织总路径、其他空间名称或内部计算细节。

## 4. 数据与接口

- `organization.storage_quota_bytes`：非空默认 `1073741824`。
- `storage_reservation`：组织、字节数、过期时间和创建时间；不保存文件正文、路径或用户原始名称。
- `resource_upload.storage_reservation_id`：关联分片会话预留；完成状态转换时释放。

```text
GET /api/settings/storage-usage
```

- 仅组织 owner/admin 可读取当前额度、实际占用、活跃预留和可用容量；不返回 Blob URI 或其他组织数据。

## 5. 验收

- 小文件上传和分片会话均在 Blob 写入前超限拒绝，且不创建新的 Blob、Resource、Version、Job 或 Outbox。
- 两个并发分片会话分别申请超过剩余额度的容量时，最多一个成功。
- 已过期 reservation 不再阻止新上传；过期 `open` 会话对应的已记录临时文件会由 Worker 清理。
- 完成分片会话后 reservation 释放，实际 Blob 仍被准确计量；同一 Blob 被多个版本引用时只计一次。
- 管理设置显示脱敏用量汇总；未登录 401，非管理员 403。
- `pnpm db:migrate`、`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 和 `pnpm test:e2e` 通过。

## 6. 非范围

- 多套餐计费、空间/用户子配额、充值、软配额、告警通知、配额后台编辑 UI。
- 磁盘可用空间预检、S3 供应商用量核对、自动删除或压缩原始资料。
