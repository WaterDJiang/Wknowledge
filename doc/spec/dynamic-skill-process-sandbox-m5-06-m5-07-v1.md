# 动态 Skill 进程 Sandbox M5-06/M5-07 Spec v1

## 1. 关联计划

- 工作包：`M5-06`、`M5-07`，接续 SkillRun、Sandbox 准入、独立目录和固定 JSON I/O。
- 上游：[Skill Sandbox 准入](sandbox-admission-m5-06-m5-07-v1.md)。
- 状态：开发中。本切片只交付 Linux 容器中 fail-closed 的动态 CLI 进程运行器与供应链检查；不开放任何内置 Skill、模型或学习生成 Skill。

## 2. 目标

- 启动动态 CLI 前验证受管入口文件、固定入口 ID、内容摘要、输入/产物目录与资源限制。
- 使用 Bubblewrap 的新用户/挂载/PID/网络命名空间运行子进程；没有 Bubblewrap 或不在受支持 Linux 运行时时拒绝，不回退为宿主进程执行。
- 子进程只接收固定 `--input {input}/input.json --artifacts {artifacts}` 参数和最小环境；不继承数据库、模型密钥、宿主工作目录或任意 HTTP 输入。

## 3. 固定运行模型

```text
已通过 Manifest / Policy / Approval / Scope 重核的 SkillRun
→ 校验 registry 固定 runtime、entry 文件及 sha256
→ 创建并写入受管 Sandbox input.json
→ bwrap --unshare-all --unshare-net --die-with-parent
→ 只读挂载 entry + input；仅 artifacts/tmp 可写
→ 固定参数数组启动 node/python CLI
→ 超时终止、读取 artifacts/result.json、Schema 重核
```

- Linux 镜像必须安装 `bubblewrap`；生产 Worker 仅使用 `/usr/bin/bwrap` 或运维显式配置的绝对二进制路径。
- 入口注册项由 Worker 配置构造，包含固定 runtime、解释器路径、入口文件和 SHA-256；Manifest、用户、上传资料、HTTP 请求均不能提供可执行命令、解释器、额外参数或环境变量。
- 入口文件必须是注册根目录内的常规非符号链接文件；摘要不一致、路径跳出、未受支持运行时、`network !== deny`、模型能力或模型调用不为零均拒绝且不启动进程。
- Bubblewrap 必须有 `--unshare-all`、`--unshare-net`、`--new-session`、`--die-with-parent`；input 与 entry 只读，`artifacts`/`tmp` 唯一可写挂载。禁止绑定原始 Blob、`raw/`、Wiki、数据库、宿主家目录或整个工作区。
- 运行环境仅保留 `HOME`/`TMPDIR` 为受管 tmp、固定 `PATH` 与 UTF-8 locale；`DATABASE_URL`、模型密钥和调用方环境变量不传递。
- Node 在时限到达时杀死整个独立进程组；内存/cgroup 限额和非 Linux 隔离器属于生产加固后续，因而本切片不允许把未配置 cgroup 的动态执行标记为生产启用。

## 4. 失败码与审计

| 情况                              | 错误码                                                                |
| --------------------------------- | --------------------------------------------------------------------- |
| 当前平台或 Bubblewrap 不可用      | `SKILL_SANDBOX_RUNTIME_UNAVAILABLE`                                   |
| 入口文件、目录或摘要不匹配        | `SKILL_SANDBOX_ENTRYPOINT_INVALID`                                    |
| 非零退出                          | `SKILL_SANDBOX_PROCESS_FAILED`                                        |
| 超时或取消                        | `SKILL_SANDBOX_PROCESS_TIMED_OUT` / `SKILL_SANDBOX_PROCESS_CANCELLED` |
| result 缺失或不符合固定 JSON 协议 | 既有 `SKILL_SANDBOX_RESULT_*`                                         |

- 不保存 stdout/stderr、输入正文、答案键、环境、Blob URI 或路径。上层 SkillRun 只记录稳定错误码、耗时、入口 runtime 与脱敏计数。

## 5. 验收

- 所有拒绝分支在启动进程前失败；测试验证不存在解释器/脚本/用户参数的宿主直接执行回退。
- 构造的 Bubblewrap 参数包含网络隔离、只读 input/entry、仅 artifacts/tmp 可写和最小环境；注册摘要或符号链接漂移被拒绝。
- 超时、取消、非零退出与非法 result 都有稳定失败结果，且不会回显 stdout/stderr。
- Docker 镜像安装 Bubblewrap；`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 通过。

## 6. 明确后置

- 动态 Skill 的管理端安装/设置页发现与组织级发布流程。
- cgroup 内存/CPU 限制、seccomp、容器 UID/只读根文件系统、Windows/macOS 等价隔离器。
- 生成型 `plan-compose`、`practice-generate`、`assessment-generate`、`rubric-grade` 和任何模型能力。
