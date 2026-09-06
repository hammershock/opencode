---
id: 0001
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

# RFC-0001：Shell 执行 Scope

## 摘要

为 OpenCode 增加一个可在 UI panel 中启用或关闭的实验性 Shell enhancement。它解决用户 Shell 命令彼此独立、不能继承 `cwd` 和其他 Shell 状态的问题，提供完整 Shell 补全，并定义用户 Shell、Agent Shell、Terminal panel 和 Location 环境的边界。用户 Shell 命令及其结果继续进入 Session，使 Agent 能在后续对话中看到；Terminal panel 仍是独立的交互终端，不自动进入 Session。

本 RFC 不决定命令运行在本地还是远程。执行位置由 Session Location 提供；RFC-0002 只负责把同一个执行 scope 扩展到 Rexd target。

## 当前行为

当前 OpenCode 存在三条不同的命令执行路径：

1. TUI Shell mode 调用 `session.shell`。每条命令启动一个新的 Shell 子进程，使用 Session directory 作为 `cwd`，命令结束后进程退出。
2. Agent bash tool 每次调用创建一个新进程，默认工作目录为当前 Location，也不保留前一次工具调用的 Shell 状态。
3. Web/Desktop App 的 Terminal panel 使用 PTY，可以保持一个或多个交互 Shell 进程，但它是独立终端，并未作为 TUI Shell mode 或 Agent tool 的执行后端。当前 TUI 没有同等的 Terminal panel。

TUI 中以 `!` 开头的用户 Shell 命令会作为 synthetic user message 和 assistant tool result 写入 Session，因此结果会成为后续 Agent 上下文的一部分。Terminal panel 的输入输出不写入 Session，也不会被 Agent 自动看到。这两种入口服务于不同用途。

在 Web/Desktop App 中可以用 `/terminal` 或 `Ctrl+反引号` 打开/关闭 Terminal panel，使用 `Ctrl+Alt+T` 新建 terminal tab；焦点位于 terminal 时，`Mod+W` 关闭当前 tab。快捷键仍受平台和用户 keybind 配置影响。

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
6. 用户 Shell 提供完整补全，包括路径、可执行命令以及当前 Shell 可以提供的原生 completion。
7. Agent Shell 保持上游默认的一次性、隔离执行语义，不共享 User Shell 的可变进程状态。
8. 实验性加载 Location 用户级和工作目录级 `.env`，为 Agent Shell、User Shell 和 Terminal panel 提供一致的基础执行环境。
9. 明确定义命令是否写入 Session，以及是否投影到 Agent 模型上下文。

## 非目标

本 RFC 当前不包含：

- 本地或远程 target 的选择；
- Rexd/SSH transport；
- 多设备同步；
- 恢复 OpenCode 进程退出前仍在运行的 Shell 进程；
- 完整复刻任意终端模拟器；
- 执行 `.env` 中的 Shell 代码；
- 让 Agent 与用户共享一个持久 Shell；
- 把 `.env` 的内容或值写入 Session、日志或模型上下文。

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

Agent bash tool 继续使用隔离的一次性进程，并以 Session Location directory 为默认工作目录。它不继承 User Shell 的 `cd`、alias、function、后台 job 或运行时修改。

Agent 与 User Shell 可以共享由 Location 环境加载器产生的不可变基础环境快照，但不共享随后发生的可变 Shell 状态。

## 用户与 Agent 的隔离决策

用户 Shell 持久，Agent Shell 无状态。二者只共享 Session Location 和明确配置的基础环境。

优点：Agent 工具调用更容易复现和重试，用户与 Agent 命令可以并发，权限检查与输出归属清晰，用户定义的 alias/function 不会改变 Agent 命令含义。

代价是用户执行 `source .venv/bin/activate` 后，Agent 不会自动进入该运行时环境，且用户 Shell 当前目录可能与 Agent 默认目录不同。用户如果希望双方获得相同环境，应通过用户级/Location `.env` 或明确的 OpenCode 环境配置表达，而不是依赖 User Shell 的隐式历史。

不共享持久 Shell，原因包括：

- 同一时间只能安全执行一个前台命令，需要串行队列；
- 交互程序、后台 job 和残留输入可能破坏下一次 Agent 调用；
- 很难可靠划分每条命令的输出；
- Agent 可以受到用户 alias/function 的隐式影响；
- 超时或中断可能损坏整个共享 Shell；
- 工具重试不再具有稳定的初始状态。

改变这一隔离决策需要后续 RFC，不能作为普通配置选项悄悄引入第二套 Agent 执行语义。

## 实验性开关

建议在 Session 相关 panel 中提供：

```text
Persistent user shell: Off | On
```

开关是 Session 级，而不是修改整个 OpenCode 进程的全局 Shell。默认值为 `Off`，以保证未主动启用时维持上游行为。

`.env` 加载使用单独的用户级实验配置，不保存在 Session：

```text
Load Location .env: Off | On
```

该设置可以在配置 panel 中修改，并持久化到用户配置。它控制所有 Location 的环境加载策略；具体加载结果只存在于当前 Location runtime。

## 补全边界

完整补全是本 RFC 的必需子功能，不降级为仅路径补全。它至少包括：

- 当前 User Shell `cwd` 下的文件和目录；
- 当前 `PATH` 中的可执行命令；
- 当前 Shell 中定义的 alias 和 function；
- bash/zsh 等当前 Shell 已注册的原生 completion；
- 对带空格、引号、转义和光标位于行中间的输入进行正确替换。

实现时仍需区分两层能力：

### TUI 侧补全

OpenCode 根据当前 User Shell `cwd` 和执行环境查询命令名和文件路径，在 prompt 中显示候选。它负责稳定的候选数据结构、排序和 TUI 交互。

优点是行为可控，容易支持本地和远程 Location；缺点是不能自动复用用户 Shell 中复杂的 completion functions。

### 原生 Shell 补全

通过当前持久 Shell 获取 alias、function 和 bash/zsh 原生 completion。实现可以使用 Shell 专用 completion API、受控辅助进程或 PTY 协议，但不能简单把 Tab 发送给用户可见终端后猜测屏幕内容。

完整补全必须通过独立原型验证后再确定底层协议。协议必须返回结构化候选和替换范围，不允许把含 ANSI 控制序列的终端屏幕文本直接作为补全结果。

## 环境与 `.env`

`.env` 加载是本 RFC 的实验性必需能力。它构造一个 Location runtime 级的不可变 `EnvironmentSnapshot`，供执行进程启动时使用；它不是 Shell 初始化脚本，也不是 Session 消息。

启用 `Load Location .env` 后，按以下顺序加载，后者覆盖前者的同名键：

```text
Location 基础环境
  -> Location 用户级 .env
  -> Location 工作目录级 .env
```

建议的默认路径是：

- 用户级：`<Location user home>/.config/opencode/.env`；
- 工作目录级：`<Session Location directory>/.env`。

这里的“用户级”属于所选 Location：本地 Location 读取本机用户目录，远程 Location 通过对应 Location 文件系统读取远程用户目录。RFC-0002 必须保持同一语义，不能先在本机读取 `.env` 再把值转发给远程进程。

解析器只接受 `.env` 键值语法，不执行 command substitution、`source`、Shell function 或任意脚本。是否兼容变量插值、引号和多行值必须由统一解析器明确定义，Agent Shell、User Shell 和 Terminal panel 不得各自解析。

`EnvironmentSnapshot` 应用于：

- 每次新建的 Agent Shell 子进程；
- 一次性 User Shell，或持久 User Shell 启动时；
- 新建的 Terminal panel PTY。

它不应用于模型 provider、OpenCode 控制进程或其他非执行子系统。快照值不得写入 Session 消息、模型上下文、遥测或普通日志；运行时可以保留来源路径、加载时间、generation 和不包含值的诊断信息。

显式执行 `env`、`echo "$TOKEN"` 等命令仍可能把输出写进 Session。这是用户命令输出的既有语义，不等同于 OpenCode 自动泄露 `.env`；UI 应在启用功能和 `/env list` 中明确提示这一风险。

### 加载与刷新

进入 Session runtime 或首次需要执行时创建快照，避免把值持久化进 Session。配置关闭时不读取上述文件。

`/env reload` 重新读取两级文件并创建新 generation：

- 后续 Agent Shell 调用立即使用新快照；
- 一次性 User Shell 的后续命令立即使用新快照；
- 持久 User Shell 必须显式重启后才能获得新环境，因此 reload 会提示并重置该 Shell，其 `cwd`、jobs、alias、function 和其他可变状态会丢失；
- 已运行的 Terminal PTY 无法由父进程可靠改写环境，只标记为 stale；新建或由用户重启的 terminal 使用新快照，不静默终止现有 PTY。

### `/env` 命令

新增以下命令：

- `/env list`：显示开关状态、generation、来源文件及变量名；值默认始终遮蔽。它是本地控制命令，不写入 Session，也不进入模型上下文。
- `/env reload`：执行上述刷新流程并显示诊断。它是本地控制命令，不写入 Session，也不进入模型上下文。
- `/env init`：参照 `/init` 实现为 prompt command，调用 Agent 在 Location 工作目录创建或完善 `.env`。它的请求和 Agent 回复写入 Session 并进入模型上下文，但 OpenCode 不把已加载的环境值附加到 prompt。

`/env init` 应优先生成带说明的模板，不复制用户级 `.env` 的值，并提醒用户检查 `.gitignore`。如果目标 `.env` 已存在，Agent 必须先读取并增量处理，不能无条件覆盖。

## 命令、Session 与 Agent 上下文

“执行一个斜杠命令”“写入 Session”和“进入 Agent 上下文”是三个不同维度。命令注册应声明以下 effect，而不是由命令名称或 UI 入口隐式决定：

1. `runtimeEffect`：只改变 UI 或 runtime，还是提交 prompt/执行操作；
2. `conversationRecord`：是否生成可持久化、可回放的 Session part；
3. `modelProjection`：哪些持久化 part 可以投影到后续模型上下文；
4. `agentInvocation`：是否立即调用 Agent 或 subagent。

本 RFC 规定：如果内容会进入模型上下文，它原则上也必须存在于可审计、可回放的 Session 记录中。`.env` 值等 secret-bearing runtime state 是明确例外方向：它既不自动记录，也不自动投影。

| 入口                        | Runtime/control | 写入 Session | 进入后续 Agent 上下文  | 立即调用 Agent |
| --------------------------- | --------------- | ------------ | ---------------------- | -------------- |
| `/help`、`/terminal`        | 是              | 否           | 否                     | 否             |
| `/env list`、`/env reload`  | 是              | 否           | 否                     | 否             |
| `!command`                  | 执行 User Shell | 是           | 是，作为命令及工具结果 | 否             |
| `/init`、`/env init`        | 提交 prompt     | 是           | 是                     | 是             |
| custom prompt command       | 提交 prompt     | 是           | 是                     | 是或 subagent  |
| Terminal panel 的输入与输出 | 操作 PTY        | 否           | 否                     | 否             |

这是命令定义层的声明式能力，不建议做成允许用户随意把任意命令改为“进入/不进入上下文”的通用开关，否则同一个 Session 的回放、权限和审计语义会随本地配置变化。以后可以为个别命令设计明确、安全的选项。

Terminal panel 继续用于 REPL、全屏程序、后台任务和多标签长期操作。User Shell `!command` 用于希望被对话记录并让 Agent 看到结果的有界命令。这两者都需要保留；持久 User Shell enhancement 是第三种执行模式，不应通过捕获整个 Terminal 屏幕来实现。

## 实现方向

持久 User Shell 需要一个命令会话抽象，而不是简单缓存 `cwd` 和环境变量：

```text
ShellSession
  start(location, shell, environment)
  execute(command)
  complete(input, cursor)
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
- User Shell 状态意外泄漏到 Agent 时，权限检查无法反映 alias/function 的真实行为；
- 本地和 Rexd provider 的状态语义不一致。

## 建议的第一阶段

第一阶段验证完整产品边界，但各能力仍由实验开关保护：

1. 功能默认关闭，可在当前 Session 的 panel 中打开或关闭。
2. 每个 Session 最多创建一个持久 User Shell。
3. 连续用户命令继承真实 `cwd`、exported variables 和 venv 激活结果。
4. Agent bash tool 继续隔离、无状态，以 Session Location 为默认目录。
5. 提供本 RFC 定义的完整补全；在完成独立原型前不宣称该阶段完成。
6. 用户级实验开关控制两级 `.env` 加载，并统一注入三个执行面。
7. 实现 `/env list`、`/env reload` 和 `/env init` 及其 Session/context policy。
8. Shell 异常后允许显式 reset；不伪造已经丢失的状态。
9. 用同一组 contract tests 验证本地 Location，并为 RFC-0002 暴露 provider-neutral 接口。

## 待确认问题

在本 RFC 从 `draft` 变为 `accepted` 前，需要确认：

1. Persistent user shell 开关是否随 Session 持久化，还是只在当前运行期间生效？
2. Location 用户级 `.env` 的默认路径是否采用 `<Location user home>/.config/opencode/.env`，以及是否允许用户覆盖路径？
3. `.env` 的变量插值、多行值和空值采用哪套精确兼容规则？
4. `/env list` 是否永远只显示变量名，还是提供需要二次确认的临时 reveal UI？
5. `/env reload` 对持久 User Shell 的重启应立即发生，还是先等待当前命令结束并请求确认？

## 参考实现

- [OpenHands Terminal Tool](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-tools/openhands/tools/terminal/README.md) 使用持久 Shell 保存工作目录、环境变量和 virtual environment。
- [SWE-ReX usage](https://github.com/SWE-agent/SWE-ReX/blob/main/docs/usage.md) 同时区分一次性 `execute` 和保留环境状态的 `run_in_session`。
- [SWE-ReX architecture](https://github.com/SWE-agent/SWE-ReX/blob/main/docs/architecture.md) 支持多个独立 session 并行运行命令和交互工具。

这些实现证明持久 Agent Shell 可行，但不代表其用户/Agent 共享策略适合直接复制到 OpenCode。
