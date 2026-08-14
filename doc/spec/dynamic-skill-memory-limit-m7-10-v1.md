# M7-10-E 动态 Skill 内存限制 Spec v1

## 1. 关联

- 工作包：`M7-10` 安全测试；关联 `M5-06/M5-11` Skill Sandbox 与资源耗尽验证。
- 发现来源：2026-08-14 安全扫描中风险“动态 Skill `limits.memoryMb` 已声明但未落实”（CWE-400）。
- 影响面：动态 Skill Bubblewrap 命令、运行时失败边界、Sandbox 回归和安全运行设计。

## 2. 目标

- 每次受管动态 TypeScript/Python JSON CLI Skill 执行都将 manifest 的 `limits.memoryMb` 转换为 Linux 进程地址空间限制。
- 无法提供该限制的运行时保持 fail-closed，不回退为宿主机本地进程。
- 限额与既有超时、无网络、只读输入/Skill 文件、受控产物目录和进程组终止共同生效。

## 3. 规则

- 仅已通过 Schema 的正整数 `memoryMb` 可进入 Sandbox；值转换为 `memoryMb * 1,048,576` 字节，并作为 Bubblewrap `--rlimit-as` 参数传入。
- Bubblewrap 子进程及其后代继承地址空间 hard/soft limit；限额触发导致非零退出时按既有 `SKILL_SANDBOX_PROCESS_FAILED` 失败，不读取或发布产物。
- Worker 不尝试在宿主机执行 `ulimit`、不接受 Skill 自定义 shell 参数，也不因 Bubblewrap 不支持资源限制而降级执行。
- `--rlimit-as` 限制的是每个进程地址空间，不等于容器级聚合物理内存配额；生产容器仍必须设置 Worker cgroup `memory.max`。该容器级演练属于 M7 部署加固，不在本切片伪称完成。

## 4. 验收标准

- 64 MiB manifest 生成的 Bubblewrap 命令必须包含 `--rlimit-as 67108864`，且不影响现有只读挂载、无网络或 JSON 参数。
- 改变 manifest 内存值会改变唯一的 Sandbox 限额参数；超时和取消路径保持原有进程组终止行为。
- 无 Bubblewrap/非 Linux 运行时仍稳定返回 `SKILL_SANDBOX_RUNTIME_UNAVAILABLE`，不执行 Skill 程序。
- 新回归、完整质量门禁均通过；运行记录不泄露绝对路径、密钥或输入正文。

## 5. 非范围

- cgroup v2 每个 Skill 聚合内存配额、CPU/进程数/磁盘 I/O 配额、OOM 事件采集与生产容器 runtime 的资源编排。
- 内置 Worker Skill、模型调用或 Python 文件解析 CLI 的资源限制改造。
