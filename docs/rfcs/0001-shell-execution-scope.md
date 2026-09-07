---
id: 0001
title: Execution Scope Model
status: accepted
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-06
implemented-by:
  - https://github.com/hammershock/opencode/pull/86
supersedes: []
superseded-by: []
---

# RFC-0001：执行 Scope 模型

## 摘要

定义 OpenCode 中 Session Location、User Shell、Agent execution 和 Terminal panel 的职责边界。用户与 Agent 使用同一个 Session Location，但默认不共享可变 Shell 状态；Terminal panel 继续作为独立交互终端；用户从对话框执行的有界 Shell 命令及结果可以记录在 Session 中，供后续 Agent 使用。

本 RFC 只建立跨功能都必须遵守的语义，不规定 User Shell cwd 连续性、补全、`.env` 或 slash command 的具体实现。Rexd 远程执行只扩展 Location 的 provider，不改变这些上层语义。

## 当前行为

当前 OpenCode 存在三条不同的命令执行路径：

1. TUI Shell mode 调用 `session.shell`。每条命令启动一个新的 Shell 子进程，使用 Session directory 作为 `cwd`，命令结束后进程退出。
2. Agent bash tool 每次调用创建一个新进程，默认工作目录为当前 Location，也不保留前一次工具调用的 Shell 状态。
3. Web/Desktop App 的 Terminal panel 使用 PTY，可以保持一个或多个交互 Shell 进程，但它是独立终端，并未作为 TUI Shell mode 或 Agent tool 的执行后端。当前 TUI 没有同等的 Terminal panel。

TUI 中以 `!` 开头的用户 Shell 命令会作为 synthetic user message 和 assistant tool result 写入 Session，因此结果会成为后续 Agent 上下文的一部分。Terminal panel 的输入输出不写入 Session，也不会被 Agent 自动看到。

在 Web/Desktop App 中可以用 `/terminal` 或 `Ctrl+反引号` 打开/关闭 Terminal panel，使用 `Ctrl+Alt+T` 新建 terminal tab；焦点位于 terminal 时，`Mod+W` 关闭当前 tab。快捷键仍受平台和用户 keybind 配置影响。

## 核心概念

### Session Location

Session Location 是会话执行位置的唯一事实来源，至少包含 target 和工作目录。它不应从 OpenCode 进程当前目录或某个 Shell 的当前状态重新推断。

Session Location 的 target 扩展由 RFC-0002 定义。

### User Shell scope

User Shell 是用户从对话输入区主动执行命令的 scope。命令及其结构化结果可以成为 Session 记录，使 Agent 在后续对话中看到用户已经执行的操作。

User Shell 是一次性还是持久、如何补全、如何中断及恢复，由 RFC-0004 定义。

### Agent execution scope

Agent Shell 保持一次性、隔离执行语义，以 Session Location directory 为默认工作目录。它不继承 User Shell 的 `cd`、alias、function、jobs 或其他运行时修改。

用户与 Agent 可以共享明确构造的基础环境，但不能隐式共享 User Shell 的可变进程状态。环境来源及生命周期由 RFC-0005 定义。

### Terminal panel

Terminal panel 是面向 REPL、全屏程序、后台任务和多标签长期操作的交互 PTY。它的输入输出默认不写入 Session，也不投影到 Agent 上下文。

如果未来需要把一段 Terminal 输出发送给 Agent，应设计显式的选择与发送操作，不能默认捕获整个终端历史。

## 决策

```text
Session Location
  target + directory
        |
        +-- User Shell scope
        |
        +-- Agent execution scope (隔离、一次性)
        |
        +-- Terminal PTY scope
```

1. 三种执行面共享 Location，不代表共享同一个 Shell 进程。
2. Agent execution 默认与 User Shell 的可变状态隔离；改变这一点需要新的 RFC。
3. User Shell 中的 `cd` 不修改 Session Location，因此不会隐式改变 Agent、文件浏览器或新 Terminal 的默认工作目录。
4. User Shell 命令及结果可以进入 Session 和后续 Agent 上下文；Terminal 输入输出默认不进入。
5. 本地和远程 Location 必须提供一致的上层 scope 语义。

## 已接受的默认兼容行为

本 RFC 接受时明确冻结以下默认行为。后续实验性功能只能通过显式开关提供，不能改变这些默认值：

| Execution scope       | 默认行为                                                                            |
| --------------------- | ----------------------------------------------------------------------------------- |
| Terminal panel        | 保持 upstream 的独立 PTY 行为；输入和输出不写入 Session，也不提供给 Agent 上下文    |
| Agent tool execution  | 保持 upstream 的一次性、隔离执行；不继承 User Shell 的可变状态                      |
| User Shell scope      | 保持 upstream 的一次性 Shell 行为；每条命令创建独立进程                             |
| User Shell transcript | 保持现有 `!command` 语义，命令及结构化结果写入 Session，并可由后续 Agent 上下文读取 |

因此，“Terminal 不进入上下文”和“User Shell 结果可进入上下文”是有意的产品差异，不应被统一执行基础设施抹平。RFC-0004 可以在不保留 Shell 进程的前提下增加实验性的 runtime cwd 连续性，但关闭实验开关时必须完全回到本表所述行为。

隔离 Agent 与 User Shell 可以保持工具调用可复现、可重试和可并发，并避免 alias、function、交互程序或后台 job 隐式改变 Agent 命令的含义。

## 下游 RFC

| RFC      | 职责                                                             |
| -------- | ---------------------------------------------------------------- |
| RFC-0002 | 扩展 Session Location，使工作区执行可由本地或 Rexd target 提供   |
| RFC-0003 | 为 Core 开发和下游 fork 提供 command toolkit，并隔离上游兼容边界 |
| RFC-0004 | 定义一次性 User Shell 的 runtime cwd 连续性、完整补全和失败恢复  |
| RFC-0005 | 定义 Location `.env` 来源、覆盖、刷新、安全边界和 `/env` 命令    |

这些 RFC 可以分别讨论和实现，但不得违反本 RFC 的隔离与 Location 边界。

## 非目标

本 RFC 不定义：

- 本地或远程 target 的配置和 transport；
- 持久 User Shell 或进程恢复协议；
- Shell completion 的实现；
- `.env` 路径、解析、覆盖或刷新机制；
- slash command 的注册和上下文策略；
- 多设备同步；
- OpenCode 退出后恢复仍在运行的 Shell 进程。

## 验收条件

1. 后续执行相关 RFC 明确说明使用哪个 execution scope。
2. Agent execution 不会隐式继承 User Shell 的可变状态。
3. User Shell 状态变化不会修改 Session Location。
4. Terminal panel 不会在没有显式用户操作时把输入输出写入 Session。
5. Rexd provider 可以扩展 Location，而无需重新定义用户、Agent 和 Terminal 的关系。

## 参考实现

- [OpenHands Terminal Tool](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-tools/openhands/tools/terminal/README.md) 使用持久 Shell 保存工作目录、环境变量和 virtual environment。
- [SWE-ReX usage](https://github.com/SWE-agent/SWE-ReX/blob/main/docs/usage.md) 同时区分一次性 `execute` 和保留环境状态的 `run_in_session`。
- [SWE-ReX architecture](https://github.com/SWE-agent/SWE-ReX/blob/main/docs/architecture.md) 支持多个独立 session 并行运行命令和交互工具。

这些实现说明持久执行 session 是可行的，但不决定 OpenCode 应当共享哪些 scope。
