---
id: 0004
title: User Shell Session
status: draft
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

# RFC-0004：User Shell Session

## 摘要

为对话输入区中的 User Shell 定义一次性与持久两种执行模式。持久模式是实验性功能，目标是让连续用户命令继承真实 Shell 状态，同时提供完整补全；Agent execution 仍遵守 RFC-0001 的隔离语义。

本 RFC 尚未确定进程协议、开关生命周期和失败恢复细节。

## 已确定需求

1. 当前一次性 User Shell 行为继续作为默认基线。
2. 持久 User Shell 通过实验性 panel 开关启用或关闭。
3. 启用后，每个 Session 最多拥有一个独立 User Shell 进程。
4. 连续命令至少继承真实 `cwd`、exported environment 和 virtual environment 激活结果。
5. User Shell 中的 `cd` 不修改 Session Location。
6. Agent Shell 保持隔离和一次性，不继承 User Shell 的可变状态。
7. 命令及结构化结果继续按照现有 `!command` 语义写入 Session，使后续 Agent 可以看到。
8. 完整补全是必需功能，不降级为只补全文件路径。

## Shell 状态边界

Shell 状态不等于环境变量。持续 Shell 可能持有：

- 进程当前目录；
- exported 和未导出的变量；
- functions、aliases 和 shell options；
- `umask`、jobs、文件描述符；
- virtual environment 激活产生的变量和函数。

因此，持久模式不能仅通过保存 `PWD` 或比较环境变量来模拟，必须复用持续进程，或者在本 RFC 中明确缩小承诺范围。

## 完整补全需求

补全至少覆盖：

- 当前 User Shell `cwd` 下的文件和目录；
- 当前 `PATH` 中的可执行命令；
- 当前 Shell 中定义的 alias 和 function；
- bash/zsh 等 Shell 已注册的原生 completion；
- 带空格、引号、转义及光标位于行中间时的正确替换。

补全协议应返回结构化候选和替换范围。不能简单向用户可见 PTY 发送 Tab，再把含 ANSI 控制序列的屏幕文本当作候选。

## 候选抽象

```text
UserShellSession
  start(location, shell, environment)
  execute(command)
  complete(input, cursor)
  interrupt()
  reset()
  close()
```

这只是讨论接口。是否基于现有 PTY、受控 Shell helper 或 Shell 专用 completion API，需要原型验证后决定。

## 待确认问题

1. 实验开关是只在当前运行期间生效，还是随 Session 持久化？
2. 从一次性切换到持久模式时，是否立即创建 Shell，还是首次执行时懒创建？
3. 关闭持久模式或 reset 时，如何处理仍在运行的前台命令与后台 jobs？
4. 如何可靠标记一条命令的开始、结束、退出码和输出边界？
5. 交互命令请求 stdin 时，应转入 Terminal panel、临时交互模式，还是拒绝？
6. timeout、中断或 Shell crash 后，何时自动重建，何时必须由用户确认？
7. bash 与 zsh 的完整补全分别通过什么稳定协议实现？
8. 本地和 Rexd Location 如何运行相同的 contract tests？

## 非目标

- 让 Agent 与用户共享持久 Shell；
- 修改 Session Location；
- 定义 `.env` 文件来源和刷新；
- 替代 Terminal panel；
- 恢复 OpenCode 退出前仍在运行的 Shell 进程。
