---
id: 0002
title: Shell Execution Scope
status: draft
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-06
implemented-by: []
supersedes: []
superseded-by: []
---

# RFC-0002：Shell 执行 Scope

## 摘要

为 OpenCode 增加一个可在 UI panel 中启用或关闭的实验性 Shell enhancement。它首先解决用户 Shell 命令彼此独立、不能继承 `cwd` 和其他 Shell 状态的问题，并为补全、环境继承以及用户 Shell 与 Agent Shell 的关系定义边界。

本 RFC 不决定命令运行在本地还是远程。执行位置由 Session Location 提供；RFC-0001 只负责把同一个执行 scope 扩展到 Rexd target。

## 当前行为

当前 OpenCode 存在三条不同的命令执行路径：

1. TUI Shell mode 调用 `session.shell`。每条命令启动一个新的 Shell 子进程，使用 Session directory 作为 `cwd`，命令结束后进程退出。
2. Agent bash tool 每次调用创建一个新进程，默认工作目录为当前 Location，也不保留前一次工具调用的 Shell 状态。
3. Terminal panel 使用 PTY，可以保持一个交互 Shell 进程，但它是独立终端，并未作为用户 Shell mode 或 Agent tool 的执行后端。

因此下面的连续用户命令不能按普通交互 Shell 的直觉工作：

```sh
cd src
pwd
export NAME=opencode
echo "$NAME"
source .venv/bin/activate
python --version
```

## Shell 状态模型

Shell 状态不等于环境变量。一个持续运行的 Shell 至少可能持有：

- 进程当前目录；
- exported environment variables；
- 未导出的 Shell variables；
- functions、aliases 和 shell options；
- `umask`；
- virtual environment 激活产生的变量和函数；
- 后台 jobs；
- 打开的文件描述符和其他进程内状态。

`PWD` 通常只是 Shell 对当前目录的环境变量表示；真正的 `cwd` 是进程属性。子进程不能通过修改环境变量或 `cd` 反向改变父进程。比较命令前后的环境变量只能捕获部分状态，不能等价恢复一个 Shell。

如果要求完整继承 Shell 状态，必须复用一个持续运行的 Shell 进程，或明确接受一个只模拟有限状态的方案。

## 目标

1. 将 Shell enhancement 明确标记为实验性功能。
2. 用户可以在 panel 中为当前 Session 启用或关闭该功能。
3. 启用后，连续的用户 Shell 命令可以继承真实 Shell 状态，至少包括 `cwd`、环境变量和 virtual environment 激活结果。
4. 关闭后恢复 OpenCode 当前的一次性 Shell 行为。
5. 明确定义 Session Location、用户 Shell 状态和 Agent Shell 状态的关系。
6. 在决定实现前评估补全、并发、权限、超时、中断和环境加载的边界。

## 非目标

本 RFC 当前不包含：

- 本地或远程 target 的选择；
- Rexd/SSH transport；
- 多设备同步；
- 恢复 OpenCode 进程退出前仍在运行的 Shell 进程；
- 完整复刻任意终端模拟器；
- 自动执行项目中不受信任的 `.env` 或 Shell 脚本；
- 立即让 Agent 与用户共享一个 Shell。

## 建议的状态分层

```text
Session Location
  target + directory
        |
        +-- User Shell scope (可选、持久、实验性)
        |
        +-- Agent execution scope (默认隔离、一次性)
```

### Session Location

Session Location 是持久的执行位置事实来源。它决定 target 和默认工作目录，不应该因为用户在 Shell 中执行 `cd` 而改变。

### User Shell scope

启用 enhancement 后，每个 Session 拥有一个独立的持久 User Shell。它以 Session Location directory 启动，并在后续用户 Shell 命令之间保留自己的 `cwd` 和进程状态。

User Shell 中的 `cd` 只改变 User Shell scope，不修改 Session Location。这样用户临时进入子目录不会悄悄改变 Agent、文件浏览器或 Session 的长期位置。

关闭 enhancement 时，持久 User Shell 被终止，后续用户命令恢复为一次性执行。

### Agent execution scope

第一阶段建议 Agent bash tool 继续使用隔离的一次性进程，并以 Session Location directory 为默认工作目录。它不自动继承 User Shell 的 `cd`、alias、function、后台 job 或运行时修改。

这是当前 Draft 的推荐基线，不是最终决定。共享方案见下文。

## 用户与 Agent 的关系选项

### 方案 A：始终隔离

用户 Shell 持久，Agent Shell 无状态。二者只共享 Session Location 和明确配置的基础环境。

优点：Agent 工具调用更容易复现和重试，用户与 Agent 命令可以并发，权限检查与输出归属清晰，用户定义的 alias/function 不会改变 Agent 命令含义。

缺点：用户执行 `source .venv/bin/activate` 后，Agent 不会自动进入该环境；用户 Shell 当前目录与 Agent 默认目录可能不同。

### 方案 B：共享同一个持久 Shell

用户与 Agent 命令都进入同一个 Shell 进程。

优点：`cd`、`export`、venv、alias 和 function 完全一致，最符合传统交互终端直觉。

风险：

- 同一时间只能安全执行一个前台命令，需要串行队列；
- 交互程序、后台 job 和残留输入可能破坏下一次 Agent 调用；
- 很难可靠划分每条命令的输出；
- Agent 可以受到用户 alias/function 的隐式影响；
- 超时或中断可能损坏整个共享 Shell；
- 工具重试不再具有稳定的初始状态。

### 方案 C：可选共享

默认使用方案 A，并提供额外的实验性 Session 选项，使 Agent 加入 User Shell scope。

该方案给用户最大控制力，但同时引入两套执行语义和更大的测试矩阵。建议在方案 A 稳定后再决定是否实现，不作为第一阶段验收条件。

## 实验性开关

建议在 Session 相关 panel 中提供：

```text
Persistent user shell: Off | On
Agent shell scope: Isolated | Shared (future)
```

第一阶段只实现 `Persistent user shell`；`Agent shell scope` 仅作为设计方向展示在 RFC 中，不提前加入不可用的 UI。

开关是 Session 级，而不是修改整个 OpenCode 进程的全局 Shell。默认值为 `Off`，以保证未主动启用时维持上游行为。

## 补全边界

“Shell 补全”可能表示不同能力，必须分开设计：

### TUI 侧补全

OpenCode 根据当前 User Shell `cwd` 查询命令名和文件路径，在 prompt 中显示候选。它不把 Tab 交给 Shell 自己处理。

优点是行为可控，容易支持本地和远程 Location；缺点是不能自动复用用户 Shell 中复杂的 completion functions。

### 原生 Shell 补全

把输入内容和 Tab 发送给交互 Shell，再解析终端返回的候选。它可以复用用户已有的 zsh/bash completion，但需要处理 PTY、终端控制序列、prompt 检测、不同 Shell 配置和任意补全脚本副作用。

第一阶段建议只承诺基于当前 User Shell `cwd` 的文件路径补全。命令补全和原生 Shell completion 在原型验证后再决定。

## 环境与 `.env`

建议把环境来源分成四层：

```text
Location 基础环境
  -> OpenCode 明确配置的环境覆盖
  -> User Shell 启动文件
  -> 持久 Shell 中用户执行的修改
```

当前 Draft 不建议自动加载项目 `.env`：

- `.env` 是键值文件，不等价于 Shell 初始化脚本；
- 文件可能包含密钥；
- 多个 `.env` 文件的优先级与切换目录后的行为需要单独定义；
- 用户 Shell 与 Agent 隔离时，自动加载到哪一侧并不明确。

后续如果需要 `.env`，应采用显式配置的文件列表和覆盖顺序，而不是扫描目录后自动执行。该决定可以在本 RFC 被接受前继续讨论，也可以由后续 RFC 扩展。

## 实现方向

持久 User Shell 需要一个命令会话抽象，而不是简单缓存 `cwd` 和环境变量：

```text
ShellSession
  start(location, shell, environment)
  execute(command)
  complete(input, cursor)      # 是否纳入首版待定
  interrupt()
  reset()
  close()
```

实现可以复用现有 PTY 基础能力，但不能直接假设 Terminal panel 的 PTY 已满足命令事务需求。ShellSession 必须可靠标记一次命令的开始、结束、退出状态和输出边界。

每个 Session 的 User Shell scope 最多串行执行一个前台命令。不同 Session 之间可以并发。

## 主要风险

- Shell prompt 或输出中出现控制标记，破坏命令边界识别；
- 交互命令等待输入，导致 session 无法继续；
- command timeout、中断或 shell crash 后状态不再可信；
- 后台进程继续写入，污染下一条命令输出；
- 用户启动文件输出额外文本或改变终端模式；
- 长期 Shell 持有过期凭据或环境变量；
- 开启共享后，Agent 命令权限检查无法反映 alias/function 的真实行为；
- 本地和 Rexd provider 的状态语义不一致。

## 建议的第一阶段

第一阶段只验证最小、可回退的范围：

1. 功能默认关闭，可在当前 Session 的 panel 中打开或关闭。
2. 每个 Session 最多创建一个持久 User Shell。
3. 连续用户命令继承真实 `cwd`、exported variables 和 venv 激活结果。
4. Agent bash tool 继续隔离、无状态，以 Session Location 为默认目录。
5. 提供基于 User Shell 当前 `cwd` 的路径补全。
6. 不自动加载 `.env`。
7. Shell 异常后允许显式 reset；不伪造已经丢失的状态。

## 待确认问题

在本 RFC 从 `draft` 变为 `accepted` 前，需要确认：

1. 第一阶段是否接受用户 Shell 持久、Agent Shell 隔离的默认方案？
2. enhancement 开关是只在当前运行期间生效，还是随 Session 持久化？
3. 第一阶段的补全是否只包含文件路径，还是还要包含可执行命令？
4. Agent shared scope 是否值得作为后续实验，还是明确永久隔离？
5. `.env` 是否完全交给用户 Shell/现有配置，还是以后定义显式加载策略？

## 参考实现

- [OpenHands Terminal Tool](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-tools/openhands/tools/terminal/README.md) 使用持久 Shell 保存工作目录、环境变量和 virtual environment。
- [SWE-ReX usage](https://github.com/SWE-agent/SWE-ReX/blob/main/docs/usage.md) 同时区分一次性 `execute` 和保留环境状态的 `run_in_session`。
- [SWE-ReX architecture](https://github.com/SWE-agent/SWE-ReX/blob/main/docs/architecture.md) 支持多个独立 session 并行运行命令和交互工具。

这些实现证明持久 Agent Shell 可行，但不代表其用户/Agent 共享策略适合直接复制到 OpenCode。
