---
id: 0005
title: Location Environment Loading
status: draft
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-06
implemented-by: []
depends-on:
  - 0001
  - 0003
supersedes: []
superseded-by: []
---

# RFC-0005：Location 环境加载

## 摘要

定义实验性的 Location `.env` 加载能力，包括用户级和工作目录级来源、覆盖顺序、执行面注入、安全边界，以及 `/env list`、`/env reload`、`/env init` 的行为。

本 RFC 当前记录高需求边界，但解析兼容性、刷新交互和命令实现仍待讨论。

## 已确定需求

1. `.env` 加载由用户级实验配置启用或关闭，不是 Session 级设置。
2. 配置开启时读取 Location 用户级和工作目录级 `.env`。
3. 工作目录级值覆盖用户级同名值；二者覆盖 Location 基础环境中的同名值。
4. 环境应用到 Agent Shell、一次性 User Shell，以及新建的 Terminal panel PTY。
5. Agent 与 User Shell 共享基础环境快照，但不共享随后发生的可变 Shell 状态。
6. `.env` 值不自动写入 Session、模型上下文、遥测或普通日志。
7. 解析 `.env` 数据，但不执行其中的 Shell 代码。
8. 本地和远程 Location 使用相同语义；远程 Location 从远程文件系统读取环境文件。

## 候选环境模型

```text
Location 基础环境
  -> Location 用户级 .env
  -> Location 工作目录级 .env
  -> immutable EnvironmentSnapshot generation
```

建议但尚未接受的默认路径：

- 用户级：`<Location user home>/.config/opencode/.env`；
- 工作目录级：`<Session Location directory>/.env`。

统一解析器必须明确变量插值、引号、多行值和空值规则。不同执行面不得各自解析文件。

## 执行面生命周期

- Agent Shell：每个新进程使用当前 generation。
- User Shell：每条一次性命令使用执行时的当前 generation；RFC-0004 的 runtime cwd 不影响环境 generation。
- Terminal panel：只在 PTY 创建时继承 generation，父进程无法可靠修改已运行 PTY 的环境。

## `/env` 命令草案

这些命令必须使用 RFC-0003 的 Core command toolkit 注册和编排，不得在 prompt submit 或 autocomplete 组件中自行解析。记录和上下文效果由 workflow 调用的服务产生，具体 handler 与失败语义尚未确定。

- `/env list`：候选语义是显示开关、generation、来源与变量名，默认不显示值；不进入 Session 或模型上下文。
- `/env reload`：候选语义是重建 snapshot；不进入 Session 或模型上下文。
- `/env init`：参照 `/init` 的 prompt command，调用 Agent 在工作目录创建或完善 `.env`；请求与回复进入 Session 和模型上下文，但不得把已经加载的值自动附加到 prompt。

`/env init` 不应复制用户级 `.env` 的值；如果文件已存在，也不能无条件覆盖。是否由 Agent 直接修改以及采用何种模板仍需讨论。

## 安全边界

- `/env list` 默认只显示变量名和来源，值保持遮蔽。
- 环境值不进入普通日志或错误对象。
- 显式执行 `env`、`echo "$TOKEN"` 等命令仍可能通过命令输出进入 Session，UI 应提示这一风险。
- Location 用户级环境属于所选 Location；不能先在控制设备读取 secret 再隐式转发给远端。
- `.env` 解析器不得执行 command substitution、`source`、function 或其他脚本。

## 待确认问题

1. 用户级 `.env` 的默认路径是什么，是否允许用户覆盖？
2. 使用哪套 `.env` 解析兼容规则？
3. 快照在进入 Session runtime 时建立，还是首次执行时懒加载？
4. 已运行 Terminal 应只标记 stale，提供 restart，还是有其他交互？
5. `/env list` 是否永远只显示变量名，还是允许二次确认后临时 reveal？
6. `/env init` 的 Agent prompt、模板和已有文件合并策略是什么？
7. 哪些非 Shell Agent 工具或 language server 也应继承该环境？

## Command toolkit 约束

- `/env` 是 command group，`list`、`reload`、`init` 是分别注册的叶子命令。
- 参数、帮助和补全使用 toolkit 接口，不维护第二套解析器。
- environment 查询、模板创建、Agent prompt 和 reload 逻辑位于可复用 services/workflow，不放入 UI handler。
- 对外部生态中同名命令的冲突、shadowing 和兼容行为遵守 RFC-0003。
- TUI 与 Web/Desktop 应复用相同的 Core workflow，仅分别呈现 dialog、confirmation 和结果。

## 非目标

- 执行 `.env` 中的 Shell 代码；
- 把环境值持久化进 Session；
- 让 `.env` 修改 OpenCode 模型 provider 或控制进程环境；
- 用 `.env` 同步机制替代未来的多设备配置同步。
