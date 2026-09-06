---
id: 0004
title: User Shell CWD Continuity
status: accepted
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-06
implemented-by: []
depends-on:
  - 0001
supersedes: []
superseded-by: []
---

# RFC-0004：User Shell CWD 连续性

## 摘要

保持对话输入区 User Shell 的一次性执行模型：每条命令启动新的 Shell 进程，命令结束后进程退出。实验性 CWD Continuity 开启时，OpenCode 只在当前运行进程内记住每个 Session 最近一次可验证的 User Shell cwd，并将它作为下一条 User Shell 命令和补全请求的起始 cwd。

本 RFC 不引入持久 Shell，不保存 Shell 进程或 cwd，不让 Agent 继承用户的可变状态。命令及结构化结果继续按照 RFC-0001 的 `!command` 语义写入 Session。

## 目标

1. `cd`、zoxide 等改变当前命令 Shell cwd 的操作，可以影响当前 OpenCode 运行期间该 Session 的下一条 User Shell 命令。
2. 每条 User Shell 命令仍是独立进程，保持 upstream 的有界执行、取消和清理模型。
3. cwd 连续性在 local 与 Rexd Location 上具有相同语义。
4. Shell completion 使用当前 User Shell runtime cwd，并提供 Shell 原生配置能够产生的完整候选。
5. Agent execution、Terminal panel 与 Session Location 不受 User Shell runtime cwd 影响。

## 非目标

- 保持一个常驻或可恢复的 Shell 进程；
- 跨 OpenCode 重启恢复 User Shell cwd；
- 继承前一条命令创建的变量、functions、aliases、Shell options、virtual environment 或 jobs；
- 让 Agent、Terminal panel 或文件浏览器跟随 User Shell `cd`；
- 支持需要持续 stdin、全屏界面或后台 job 管理的交互程序；
- 定义 `.env` 来源与刷新语义。

## 状态模型

```text
UserShellRuntimeState {
  sessionID
  locationIdentity
  cwd
}
```

规则如下：

- 状态只存在于当前 OpenCode server/TUI runtime 的内存中，不写文件、数据库、Session parts、同步数据或模型上下文；
- 每个 OpenCode Session 最多有一个 User Shell runtime cwd；
- 初始 cwd 是 Session Location directory；
- `locationIdentity` 至少包含 target 与 Session Location directory，用于防止状态被错误复用到另一个 Location；
- 离开再返回 Session 时，只要同一 OpenCode runtime 仍存活，状态可以继续使用；
- OpenCode 重启、实验功能关闭、Session 删除或 Location identity 改变时立即丢弃状态；
- 没有有效 runtime state 时无条件回到 Session Location directory。

实验开关是设备本地、用户级配置，并在 experimental panel 显示；默认关闭。开关可以持久化，但它控制的是功能偏好，不代表 cwd 状态可以持久化。

## 一次性执行协议

每次执行遵循：

```text
读取 Session Location
  -> 读取或初始化 UserShellRuntimeState.cwd
  -> 以该 cwd 启动新的非 PTY Shell
  -> 执行一条用户命令
  -> 收集 stdout、stderr、exit status 和可选 finalCwd
  -> 校验后更新内存 cwd
  -> 销毁进程及其非 detached 子进程
```

Location process contract 应返回独立的 `finalCwd` control result；该值不能作为用户输出文本或依靠固定、可伪造的普通 stdout marker 暴露给上层。local provider 可以使用受限 control channel；Rexd adapter 可以使用带每次执行随机 nonce 的私有 control frame，并在写入 Session 前剥离。未来 Rexd 若提供结构化 final cwd，应优先使用协议字段。

更新 cwd 必须满足：

- final cwd 是对应 target 上规范化后的绝对路径；
- Location provider 确认它可以作为下一次 process cwd；
- 未收到 control result、校验失败、连接中断、timeout 或 interrupt 时保留执行前 cwd；
- command 正常结束且 final cwd 有效时，即使 exit status 非零也可以更新，因为 cwd 与退出码是两个独立结果；
- control frame 不得进入 Session transcript、终端显示、日志或 Agent context。

本 RFC 不允许通过调用全局 `process.chdir()` 实现连续性，也不允许修改 Session Location directory。

## 状态继承边界

继承的唯一可变状态是 cwd。下一条命令会重新构造 Shell 和基础环境，因此：

- `export FOO=bar` 不影响下一条命令；
- `source venv/bin/activate` 不保持 virtual environment；
- 临时 alias、function、Shell option 和 umask 不保持；
- 后台 job 不被保留，应该改用 Terminal panel；
- RFC-0005 的 EnvironmentSnapshot 按每次新进程的规则注入，与 cwd state 分开。

这使 `cd project && command`、`zoxide` 等命令可以为后续 User Shell 选择目录，同时避免引入长期 Shell 的不可恢复状态。

## Completion

完整补全仍是必需功能，但只针对每次请求重新构造的 Shell 环境。至少覆盖：

- 当前 User Shell runtime cwd 下的文件和目录；
- 当前基础环境 `PATH` 中的可执行命令；
- Shell startup 配置提供的 aliases、functions 和原生 completion；
- 带空格、引号、转义及光标位于行中间时的正确替换；
- 结构化候选、展示文本、replacement range 和候选类型。

前一条一次性命令动态创建的 alias、function 或 completion 不在承诺范围内。completion helper 可以为每次请求启动短生命周期 Shell，但不能成为隐藏的持久 User Shell；不能向用户命令 PTY 发送 Tab 后解析 ANSI 屏幕文本。

所有 completion 请求使用当前 runtime cwd。候选生成期间 cwd state 发生变化时，旧 generation 的结果必须丢弃。

## 中断、交互与清理

- 每次命令都有独立 cancellation 与 timeout；触发后终止该命令的进程树并保留执行前 cwd。
- v1 User Shell stdin 在提交命令后不提供持续交互通道。需要密码、REPL、全屏 UI 或持续 stdin 的命令应在 Terminal panel 运行。
- 不支持 detached/background job 的生命周期承诺；一次性命令完成、取消或超时后，provider 必须尽力清理仍附着的子进程。
- Shell launch 失败、Rexd 断线或 control result 缺失时，命令返回明确错误或不确定状态，绝不切换到 local Location。
- 下一条命令可以重新创建一次性 Shell，不需要 reset 或重建持久进程。

## 与其他 Scope 的关系

```text
Session Location directory
  ├─ Agent execution cwd（每次从 Location 开始）
  ├─ Terminal PTY initial cwd（创建时从 Location 开始）
  └─ User Shell runtime cwd（可在当前 runtime 内变化）
```

User Shell command 与结果仍进入 Session，使后续 Agent 能看到用户执行过什么；只有隐藏的 runtime cwd control state 不进入 Session。Agent 如果需要改变自己的工作目录，必须在单次 tool call 中显式完成，不能读取 User Shell runtime state。

## 实现边界

```text
UserShellRuntime
  current(sessionID, location)
  execute(sessionID, location, command, environment, signal)
  complete(sessionID, location, input, cursor, environment, signal)
  reset(sessionID)
```

- runtime service 负责内存 state、generation 和 lifecycle；
- Location process/completion providers 负责 local 或 Rexd 的实际执行；
- TUI 只负责 experimental toggle、输入和结果呈现，不保存 cwd；
- command dispatch、Agent bash tool 和 Terminal PTY 不读取该 runtime service。

## 验收条件

1. 实验开关关闭时，User Shell 与 upstream 一次性执行行为一致。
2. 开启后，连续 `pwd`、`cd`、失败的 `cd` 和 `cd && command` 在同一 Session/current runtime 中按规范更新 cwd。
3. 切换 Session、Location identity 变化、关闭开关与重启 OpenCode 不会错误复用 cwd。
4. cwd state 不出现在 Session 数据库、parts、同步 payload、日志或 Agent context。
5. Agent Shell 与新 Terminal 始终从 Session Location directory 开始，不继承 User Shell cwd。
6. 环境变量、alias、function、virtual environment、umask 和 job 不跨 User Shell 命令继承。
7. local 与 Rexd providers 通过同一套 execute/finalCwd/completion contract tests。
8. timeout、interrupt、launch failure、断线、非法 finalCwd 和缺失 control result 均保留此前 cwd，并清理进程树。
9. completion 使用当前 runtime cwd，返回结构化替换范围，并覆盖 quoting、cursor-in-middle 与 stale generation。
10. 交互命令不会让 prompt 永久等待；UI 明确引导用户改用 Terminal panel。
