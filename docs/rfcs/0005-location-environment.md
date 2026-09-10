---
id: 0005
title: Location Environment Loading
status: accepted
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-10
implemented-by:
  - https://github.com/hammershock/opencode/pull/86
depends-on:
  - 0001
  - 0003
supersedes: []
superseded-by: []
---

# RFC-0005：Location 环境加载

## 摘要

定义实验性的 Location `.env` 加载能力，包括用户级和工作目录级来源、覆盖顺序、执行面注入、安全边界，以及 `/env list`、`/env reload`、`/env init` 的行为。

该能力默认关闭，由设备本地用户级实验设置控制。环境在 Session runtime 激活时加载，并只通过显式 `/env reload` 刷新。

## 已确定需求

1. `.env` 加载由用户级实验配置启用或关闭，不是 Session 级设置。
2. 配置开启时读取 Location 用户级和工作目录级 `.env`。
3. 工作目录级值覆盖用户级同名值；二者覆盖 Location 基础环境中的同名值。
4. 环境应用到 Agent Shell、一次性 User Shell，以及新建的 Terminal panel PTY。
5. Agent 与 User Shell 共享基础环境快照，但不共享随后发生的可变 Shell 状态。
6. `.env` 值不自动写入 Session、模型上下文、遥测或普通日志。
7. 解析 `.env` 数据，但不执行其中的 Shell 代码。
8. 本地和远程 Location 使用相同语义；远程 Location 从远程文件系统读取环境文件。

## 环境模型与路径

```text
目标 Location provider 的基础进程环境
  -> <Location HOME>/.config/opencode/.env
  -> <Session Location directory>/.env
  -> 调用方显式 process environment
  -> immutable EnvironmentSnapshot generation
```

路径固定为：

- 用户级：`<Location user home>/.config/opencode/.env`；
- 工作目录级：`<Session Location directory>/.env`。

用户级路径不受项目配置覆盖。本地 Location 使用本机用户 HOME，远程 Location 使用握手与环境探测确认的远端用户 HOME；控制设备的基础环境和用户级 `.env` 不得隐式转发到远端。

基础进程环境始终来自实际 target：local 使用本地 process provider 的环境，Rexd 使用远端 daemon/exec provider 在目标机器继承和报告的环境。构造 snapshot 和执行命令时使用裸、非登录、非交互 Shell，不执行 `/etc/profile`、用户 profile、`.bashrc`、`.zshrc` 或其他 startup files。需要额外变量时使用用户级或项目级 `.env`，不能依赖启动脚本的副作用。

RFC-0004 的 completion helper 可以为生成原生候选单独加载目标机器的 completion/startup 配置，但该隔离 helper 的环境变化不能回流到本 snapshot。

统一解析器采用严格 dotenv 语义：支持注释、单双引号、转义、空值和规范化换行，不支持变量插值、`export` shell 语句、command substitution、`source`、function 或其他代码。`$VAR` 和 `${VAR}` 保持普通字符串。不同执行面不得各自解析文件。

调用方为单次进程显式提供的环境具有最高优先级，但不能修改已发布的 snapshot。解析结果构成不可变、单调递增 generation；值相同的 reload 也可以产生新 generation，以提供明确的刷新边界。

## 加载与执行面生命周期

- 创建或进入 Session runtime 时立即读取两个来源并建立 snapshot；不在首次执行时懒加载。
- `.env` 文件变化不会自动刷新。只有重新进入一个已释放的 Session runtime、显式 `/env reload` 或 `/env init` 成功收尾时建立新 generation。
- 所有新启动的 Location 工作区子进程使用当前 generation，包括 Agent Shell、一次性 User Shell、Terminal PTY、LSP、formatter 和 task runner。
- RFC-0004 的 User Shell runtime cwd 不改变环境来源或 generation；工作目录级 `.env` 始终绑定 Session Location directory，而不是 User Shell 临时 cwd。
- 已运行 Terminal 不能被父进程改写环境。generation 更新后将它标记为 stale，保留现有 PTY，并提供 restart action；重启和新建 PTY 使用当前 generation。
- OpenCode 模型 provider、认证、同步和其他控制面进程不继承 Location EnvironmentSnapshot。
- Session Location 按 RFC-0009 重绑定时，旧 snapshot 立即作废并从新 Location 重新加载。

## `/env` 命令

这些命令必须使用 RFC-0003 的 Core command toolkit 注册和编排，不得在 prompt submit 或 autocomplete 组件中自行解析。记录和上下文效果由 workflow 调用的服务产生。

- `/env list`：显示开关、generation、来源、变量名和覆盖关系，默认不显示值；不进入 Session 或模型上下文。当前 `opencode-rexd` 进程首次 reveal 须由用户二次确认，确认后同一进程内不再重复询问；值只在当前临时 dialog 中显示，关闭 dialog 立即清除展示状态，值不得写入剪贴板、history 或普通日志。进程重启后必须重新确认。
- `/env reload`：重新读取、解析并校验两个来源。成功后一次性发布新 generation；任一来源失败时保留完整旧 snapshot，显示文件、行列和非敏感错误，不发布部分结果。不进入 Session 或模型上下文。
- `/env init`：参照 `/init` 的 Agent command，确保工作目录存在 `.env` 模板，再请求 Agent 根据项目完善文件，最后执行与 `/env reload` 相同的事务校验。请求与回复进入 Session 和模型上下文，但不得把已加载值自动附加到 prompt。

`/env init` 在文件缺失时创建只含说明性注释、没有 secret 或猜测值的确定性模板；文件已存在时跳过模板写入。Agent 通过正常 workspace edit/permission 路径修改文件。Agent 取消或失败时不 reload；Agent 完成但文件解析失败时保留旧 snapshot 并显示诊断。该流程不复制或列出用户级 `.env` 的值。

## 安全边界

- `/env list` 默认只显示变量名和来源，值保持遮蔽。
- reveal 必须由当前 `opencode-rexd` 进程内首次成功确认显式授权；拒绝不授予后续 reveal，授权不得持久化且进程重启后必须重新确认。
- 环境值不进入普通日志或错误对象。
- 显式执行 `env`、`echo "$TOKEN"` 等命令仍可能通过命令输出进入 Session，UI 应提示这一风险。
- Location 用户级环境属于所选 Location；不能先在控制设备读取 secret 再隐式转发给远端。
- `.env` 解析器不得执行 command substitution、`source`、function 或其他脚本。

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

## 验收条件

1. 实验开关默认关闭并持久化为设备级用户偏好；关闭时保持 upstream 环境行为。
2. local 与 Rexd Location 使用相同的路径、解析、优先级和 generation contract；远端基础环境和两个 `.env` 来源均在 target 上解析，不读取或转发控制设备环境。
3. 命令环境使用裸、非登录、非交互 Shell，不执行 startup files；completion helper 的隔离环境不能污染 snapshot。
4. 严格 dotenv parser 覆盖引号、转义、注释、空值、CRLF、字面量 `$VAR` 和所有拒绝执行的 Shell 语法。
5. Session runtime 激活与 `/env reload` 的原子发布、解析失败回滚和并发 generation 均有测试。
6. Agent/User Shell、Terminal、LSP、formatter 和 task 新进程继承当前 snapshot；provider、认证和同步进程不继承。
7. reload 后已有 Terminal 保持运行并标记 stale，restart 后使用新 generation。
8. `/env list` 默认不泄露值；临时 reveal 的进程级首次确认、拒绝后重试、进程重启复位、关闭清理、日志和 Session 隔离有测试。
9. `/env init` 对缺失、已存在、Agent 取消、编辑失败、解析失败和成功 reload 均满足规定事务。
10. 环境值不进入 Session、模型上下文、同步 payload、普通日志或错误对象。
