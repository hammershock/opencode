---
id: 0006
title: Built-in Slash Command Adjustments
status: accepted
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-07
implemented-by:
  - https://github.com/hammershock/opencode-transit/pull/86
depends-on:
  - 0003
supersedes: []
superseded-by: []
---

# RFC-0006：上游内建 Slash Command 功能调整

## 摘要

记录本 fork 对 OpenCode 上游内建 slash command 的有意功能调整。每项调整必须说明固定的 upstream baseline、原始行为、目标行为、客户端范围和兼容测试；没有列入本 RFC 的上游命令默认保持原样。

本 RFC 不定义 `/target`、`/env`、`/sync` 等 fork 新增 command family。新增 Core command 使用 RFC-0003 toolkit，并由各自的功能 RFC 规定业务语义。

## Upstream baseline

本轮盘点以 `upstream/dev` commit `337fd144d2ba144743368f78d9579a99cce175bd` 为基线。命令清单以源码注册结果为准；上游网页文档可能滞后于 `dev`。

这里的“上游内建命令”包括：

- OpenCode Core 自带的 prompt command；
- TUI、Web/Desktop 源码注册的 slash command；
- 随 OpenCode 发布并由其控制的 internal system plugin command。

不包括用户配置 command、项目 Markdown command、MCP prompt、Skill 或外部插件 command。

基线盘点的源码入口是：

- TUI 应用级注册：`packages/tui/src/app.tsx`；
- TUI prompt 注册：`packages/tui/src/component/prompt/index.tsx`；
- TUI Session 注册：`packages/tui/src/routes/session/index.tsx`；
- internal `/diff`：`packages/tui/src/feature-plugins/system/diff-viewer.tsx`；
- Core prompt command：`packages/opencode/src/command/index.ts`；
- Web/Desktop：`packages/app/src/pages/session/use-session-commands.tsx`、`use-composer-commands.tsx` 和 `packages/app/src/pages/layout.tsx`。

## 上游 TUI 内建命令清单

命令是否出现可能受当前 route、Session 状态、连接状态和 experimental flag 影响。

### 应用与导航

| 命令          | Alias                  | 基线功能                     | 条件           |
| ------------- | ---------------------- | ---------------------------- | -------------- |
| `/sessions`   | `/resume`, `/continue` | 打开 Session 列表并切换      | —              |
| `/new`        | `/clear`               | 返回首页并开始新 Session     | —              |
| `/workspaces` | —                      | 管理 experimental workspaces | experimental   |
| `/move`       | —                      | 将 Session 移到其他项目目录  | Session/prompt |
| `/warp`       | —                      | 切换 Session workspace       | experimental   |
| `/status`     | —                      | 显示 OpenCode 状态           | —              |
| `/debug`      | —                      | 显示诊断信息                 | —              |
| `/help`       | —                      | 打开帮助                     | —              |
| `/exit`       | `/quit`, `/q`          | 退出 OpenCode                | —              |

### Agent、模型与集成

| 命令        | Alias                  | 基线功能                  | 条件                  |
| ----------- | ---------------------- | ------------------------- | --------------------- |
| `/models`   | `/mo`                  | 打开模型选择              | —                     |
| `/agents`   | —                      | 打开 Agent 选择           | —                     |
| `/variants` | —                      | 打开模型 variant 选择     | 有可用 variant 时     |
| `/connect`  | —                      | 连接 provider             | —                     |
| `/org`      | `/orgs`, `/switch-org` | 切换 Console organization | 存在多个 organization |
| `/mcps`     | —                      | 打开 MCP 开关面板         | —                     |
| `/skills`   | —                      | 打开可用 Skill 选择       | prompt                |

### Session 操作与显示

| 命令          | Alias                | 基线功能                         |
| ------------- | -------------------- | -------------------------------- |
| `/share`      | —                    | 分享当前 Session                 |
| `/unshare`    | —                    | 取消分享                         |
| `/rename`     | —                    | 打开 Session 重命名对话框        |
| `/timeline`   | —                    | 打开消息时间线                   |
| `/fork`       | —                    | 从消息时间线 fork Session        |
| `/compact`    | `/summarize`         | 压缩当前 Session                 |
| `/undo`       | —                    | 回退上一条用户消息及关联文件变更 |
| `/redo`       | —                    | 恢复已回退的消息及文件变更       |
| `/timestamps` | `/toggle-timestamps` | 切换时间戳显示                   |
| `/thinking`   | `/toggle-thinking`   | 切换 reasoning block 显示        |
| `/copy`       | —                    | 复制 Session transcript          |
| `/export`     | —                    | 导出 Session transcript          |
| `/editor`     | —                    | 用外部编辑器编辑当前 prompt      |

### 其他随附命令

| 命令      | Alias | 基线功能                                           | 来源                   |
| --------- | ----- | -------------------------------------------------- | ---------------------- |
| `/themes` | —     | 选择主题                                           | TUI Core               |
| `/diff`   | —     | 打开 diff viewer                                   | internal system plugin |
| `/init`   | —     | 让 Agent 创建或更新 `AGENTS.md`                    | Core prompt command    |
| `/review` | —     | 让 subagent review commit、branch、PR 或未提交变更 | Core prompt command    |

## 上游 Web/Desktop 内建命令清单

Web/Desktop 与 TUI 不是同一份注册表。当前基线明确注册：

| 命令         | 基线功能                        |
| ------------ | ------------------------------- |
| `/share`     | 分享 Session                    |
| `/unshare`   | 取消分享                        |
| `/new`       | 新建 Session                    |
| `/undo`      | 回退上一条消息                  |
| `/redo`      | 恢复回退                        |
| `/compact`   | 压缩 Session                    |
| `/fork`      | Fork Session                    |
| `/export`    | 导出 Session                    |
| `/open`      | 打开文件                        |
| `/terminal`  | 打开或关闭 Terminal panel       |
| `/mcp`       | 打开 MCP 控制                   |
| `/model`     | 选择模型                        |
| `/agent`     | 切换 Agent                      |
| `/workspace` | 切换 workspace                  |
| `/init`      | 执行 Core `init` prompt command |
| `/review`    | 执行 Core `review` subtask      |

Server 提供的 custom command、MCP prompt 和 Skill 也可能出现在客户端 autocomplete 中，但不属于这张内建清单。

## Override 机制

对上游内建命令的调整必须通过 RFC-0003 toolkit 的显式 override/decorator 机制实现，不直接修改通用 prompt dispatch，也不复制整段上游 handler。所有 override 都放入实验性功能分区，由设备本地、用户级、默认关闭的独立 setting 控制。override 目标必须在 typecheck/build/CI 阶段完成静态验证，生产运行时不负责发现 contract drift。

每个 override 必须具有：

- 稳定的 fork command identity；
- 被调整的 upstream command identity 和 baseline version；
- 原 handler 的兼容 fallback 或可复用调用入口；
- 明确的参数、客户端和 route 范围；
- 独立的 experimental setting 和可诊断状态；
- 行为差异测试；
- upstream 同步时会让构建失败的静态 drift 检测。

如果 upstream command identity 或 contract 发生变化，类型化 manifest/verifier 必须阻止构建并要求重新审查，不能生成运行时才进入 incompatible 状态的产物，也不能静默绑定到名称相同但语义已经变化的新命令。

setting 关闭时使用完整 upstream 行为。setting 已开启但 override 在运行时无法原子安装或应用时，也必须保留 upstream handler，记录结构化 warning，并在实验功能面板标出该项“已启用但未生效”；不得导致启动失败、slash command 消失或执行到半 override 状态。该温和 fallback 只处理已通过静态验证后的运行时故障，不降低构建期 contract 检查的严格程度。

## 已确定的上游调整

以下内容吸收旧归档中的产品需求，但不复制其 prompt 字符串特判、云同步耦合或 toggle alias 等实现。

### `/exit`：Session 内返回 QuickStart

Upstream baseline：TUI 中 `/exit`、`/quit`、`/q` 直接退出应用。

目标行为：

- 该调整由设备本地、用户级的 experimental setting 控制，并在实验功能面板提供 checkbox；默认关闭；
- 开关关闭时，`/exit` 完整保持 upstream 行为；
- 开关开启且当前 route 是 Session 时，`/exit` 返回 QuickStart/home，不终止 OpenCode；
- 开关开启但当前已经位于 home 时，`/exit` 仍退出 OpenCode；
- `/quit` 和 `/q` 始终保留 upstream 的退出应用语义，作为明确的退出入口；
- 专用“立即退出应用”keybind/command 保持 upstream 行为，不被 route-sensitive slash override 替换；
- 该操作不写入 Session、不进入模型上下文、不调用 Agent。

旧实现通过拆分 `app.exit` 与 `route.exit` 达成该语义。新实现应使用 toolkit decorator 和共享导航 action，不在 prompt submit 中识别字符串。

### `/rename [title]`：支持直接重命名

Upstream baseline：TUI `/rename` 打开重命名 dialog。

目标行为：

- `/rename` 不带参数时保持原 dialog；
- `/rename <title>` 将参数剩余部分作为完整标题直接更新；
- title 只允许单行；裁剪首尾空白，保留内部空格和 Unicode；空标题退回 rename dialog；
- 没有当前 Session 时不执行，并显示明确提示；
- 不写入对话、不进入模型上下文、不调用 Agent；
- 更新必须直接调用与 rename dialog 相同的 Session rename domain API，而不是调用 `session.command`、构造 prompt 或复制更新逻辑；
- 同步功能通过 Session rename domain event 观察变化，command 本身不直接依赖百度网盘实现。

当前 upstream baseline 的 `/rename` 已直接打开 rename dialog；本 fork 的 patch 重点是让带参数形式也由客户端命令层消费，避免因参数匹配失败落入 prompt/custom-command 路径。

### `/sessions`：显示并搜索执行位置

Upstream baseline：打开 Session 列表并进行选择。

目标行为：

- 保留原选择、固定、排序和快捷键行为；
- 始终显示 Session Location；local Session 显示规范化 directory，远程 Session 显示 `target · directory`；
- 同步 metadata 可用时额外显示 device，不可用时不显示虚假占位；
- 搜索覆盖标题、target、directory，以及存在时的 device；
- target 在当前设备未配置或 Location 无法恢复时，保留该 Session 并显示 unresolved/unavailable 状态，不从列表隐藏；
- 未配置 Rexd 或同步时退化为 upstream 信息，不显示虚假占位；
- 云端 Session 的发现、按需打开和 ownership 规则由 RFC-0010 定义；
- `/sessions` 只调用可复用 Session query service，不直接实现云端下载或冲突处理。

列表在搜索框之外提供两个有约束关系的单行筛选器，并始终保持两行稳定布局：

```text
Path:   [Cwd] All
Target: [local] All mywindows a100-2gpu
```

- `Path` 的 `Cwd` 按当前工作目录筛选，`All` 不施加目录维度约束；
- `Target` 的 `local` 表示本设备本地执行位置，`All` 不施加 target 约束，其余值来自列表中可见的 Rexd target 或其他设备对外声明的本机 target 名称；
- `Cwd` 只可与 `local` 共存：选择 `Cwd` 时同时选择 `local`；选择非 `local` target 或 `Target: All` 时同时切换为 `Path: All`；选择 `local` 时保留当前的 `Cwd`/`All`；
- 本设备的 local Session 始终显示为 `local`。同步到其他设备后，以源设备稳定的 `deviceName` 作为 portable target label，例如 `mymac`；接收设备将它作为非本机 target 处理，且在用户显式配置或绑定前保持 unresolved；
- target name 只承载可移植语义提示，不能同步 target ID、SSH 配置或 credential，也不能仅因名称相同自动绑定；
- cloud-only metadata 与本机 Session 位于同一个列表，使用 `cloud` 标记；不再提供 `Synced` 或 sync-space 筛选；
- `Tab` 只在两行筛选器之间移动焦点，左右方向键改变当前行的值；搜索框仍是独立焦点和独立过滤条件；
- 两个筛选值写入本设备 OpenCode TUI KV；异步发现 cloud metadata 不得自动改变选择，已保存但暂时没有匹配项的 target 仍保留为可切换值；
- 筛选只影响当前列表视图，不改变 Session ownership、同步配置或 durable Session 数据。

`/sessions` 还可以承载 RFC-0009 定义的实验性 `Force rebind location...` 管理操作。该入口默认隐藏，只在设备级实验设置开启时显示，并必须标注为不推荐。Location 校验、空闲检查、事务提交、运行时重建和同步 revision 全部属于 RFC-0009 domain workflow，不在 Session list 组件中实现。

Session 列表中的 Location 和同步视图是一等产品功能，始终增量扩展 upstream `/sessions` 打开的同一个 dialog，不属于实验性 slash-command override。只有高风险的单 Session 强制 rebind action 受实验开关控制。

### `/models` 与 provider usage

`/models` 保持 upstream 的模型选择语义。Provider 使用量查询、可扩展 adapter、缓存，以及 `/models` 面板和 Session footer 的展示统一由 RFC-0007 规定。本 RFC 不再为 `/models` 定义不完整的 provider-specific 行为。

### `/variants` 及 variant 操作

Upstream baseline：`/variants` 打开当前模型的 variant 选择；另有循环 variant 的 keybind command。

本 fork 不调整 `/variants` 的 slash command 语义：它继续打开当前模型的 variant 选择器，只展示 provider/model 明确支持的值。reasoning effort 的快捷调整、默认 keybinding 和 Shell mode 退出键属于 TUI 输入交互，由 RFC-0008 规定，不能在 `/variants` override 中硬编码模型或按键。

## 本仓库新增的基础 Core command

以下 command family 不是当前 upstream baseline 的内建命令，因此不属于 override。它们与 `/target`、`/env`、`/sync` 一样，是本仓库计划提供的基础 Core command：

| Command family         | 从旧归档恢复的基础职责                                    |
| ---------------------- | --------------------------------------------------------- |
| `/target`              | 打开 RFC-0002 target registry manager；不切换当前 Session |
| `/env`                 | 管理 location environment                                 |
| `/sync`、`/devices`    | 管理跨设备同步和设备                                      |
| `/permissions`         | 打开现有权限模式选择面板                                  |
| `/expand`、`/collapse` | 显式展开或收起当前 Session 视图中的截断命令输出           |
| `/delete`              | 二次确认后删除当前 Session                                |

这些命令必须通过 RFC-0003 toolkit 注册，复用客户端已有的 domain action，并遵循以下边界：

- 所有可信 fork Core command 必须由同一 registry host 同时提供给 slash autocomplete、直接 submit dispatch 和 `Ctrl+P` command palette；三条入口消费相同的 identity、参数、availability 和 handler，不能维护手工重复清单。上下文不满足时可以隐藏或禁用并说明原因，不能让同一命令在不同入口解析为不同效果。
- `/permissions` 打开与现有 panel 相同的模式选择器，在“按配置规则询问”和“自动批准未被显式拒绝的请求”之间选择。command 不维护第二份 permission 状态，其生效范围和持久性与 panel 完全相同。
- `/expand` 将当前 Session route 的命令输出全局展开 override 明确设为 on；`/collapse` 明确设为 off。二者不是同一个 toggle command 的 aliases，重复执行必须幂等。
- output expansion 只属于当前客户端进程中当前 Session view 的运行时展示状态；不写入用户配置、Session、同步数据或模型上下文，route/view 销毁后可以重置。逐条点击产生的局部展开状态仍由原组件维护。
- `/delete` 只针对当前 Session，展示包含 Session title 的二次确认；取消不产生副作用。确认后调用统一 Session delete domain API，成功后返回 home 并刷新 Session 列表。
- `/delete` 不直接写同步墓碑或调用云存储。同步层只能通过正式 Session deletion event/domain change 响应删除；RFC-0010 启用时，该事件默认删除所有设备上的同步副本。
- 所有命令都不创建 Session message、不触发模型调用，也不能在 prompt submit 中按字符串特判。

### `/permissions` 的 Default 与 Session 状态

权限快捷入口使用两个明确、独立的层级：

- `Default` 是设备本地用户偏好，决定此后新建 Session 的初始 approval mode；
- `Session` 是创建 Session 时从 Default 复制的 durable 值，此后独立修改，不继续跟随 Default；
- approval mode 只有 normal（按既有权限规则询问）与 auto-approve（自动批准未被显式拒绝的请求）两种；它不替代显式 deny 规则，也不扩展工具或 Location 权限；
- 修改 Default 不回写已有 Session；修改 Session 不修改 Default；
- 旧 Session 缺少该字段时按 normal 解释，迁移不能使其自动获得更宽权限；
- Session approval mode 属于 Session durable metadata，并随该 Session 在 RFC-0010 所属同步空间内同步；设备 Default、panel 焦点和临时 UI 状态不进入同步；
- `/permissions` panel 同时清楚展示 Default 与当前 Session 值。没有当前 Session 时只能修改 Default；有 Session 时用户必须明确选择修改哪个层级。

`/target`、`/env` 和 `/sync` 的业务语义仍分别由对应 RFC 定义；本节只确认它们属于 toolkit Core command，而非 upstream override。

## 默认兼容策略

- 未列入“已接受调整”的上游内建命令保持 baseline 行为。
- 每项已接受 override 都在实验功能面板拥有独立开关，默认关闭；关闭或运行时应用失败时保持完整 baseline 行为。
- override 保留 upstream command 的公开名称、aliases 和可用条件，除非本 RFC 明确修改。
- 外部 custom command 按 upstream 冲突优先级覆盖内建名称时，仍应覆盖 fork override。
- 外部插件观察到的 hook 时机和 Session/模型行为保持兼容。
- TUI override 不自动扩展到 Web/Desktop；跨客户端一致性必须逐项写入规格。
- upstream 新增命令不会自动成为 override；同步后更新清单和 baseline。
- upstream 已经实现等价或更好的行为时，优先删除 fork override 并回归 adapter passthrough。

## 实现与测试规范

每个调整单独提交和测试，至少覆盖：

1. baseline 行为 fixture；
2. 目标行为；
3. aliases；
4. route、Session 状态和 feature flag 条件；
5. 是否创建 Session parts 或调用 Agent；
6. 外部同名 custom command 的覆盖行为；
7. TUI 与 Web/Desktop 未声明范围内不受影响；
8. upstream handler/schema drift 的静态构建失败测试；
9. 每项实验开关关闭时的 upstream passthrough，以及开启但 override 安装失败时的 warning fallback。
10. Core command 从 slash autocomplete、直接 submit 和 `Ctrl+P` 解析为同一注册项，并遵守同一 contextual availability。
11. Default 只影响之后的新 Session，Session mode 可独立持久化和同步，旧 Session 安全地回落到 normal。

不要在同一个实现提交中同时调整多个无关的上游命令。

测试应从 registry 的结构化 metadata 生成 baseline snapshot；不要另写一份只验证命令名称的手工列表。RFC 中的清单用于设计审查，snapshot 用于在同步 upstream 时发现实际注册表变化。

## 客户端范围

- RFC-0006 v1 只调整 TUI；Web/Desktop 保持 upstream 行为。
- `/rename <title>` 和 Session Location query 应沉到可跨客户端复用的 domain API，但不因此要求 Web/Desktop 暴露相同 slash command。
- `/sessions` 只消费 RFC-0002、RFC-0009 和 RFC-0010 提供的 metadata/workflow，不拥有远程连接或同步逻辑。
- `/permissions`、`/expand`、`/collapse` 和实验性 `/exit` 都是 TUI client-host effects。

## 验收条件

1. 上游内建清单与固定 baseline 的源码注册结果一致。
2. 每项已接受 override 都有明确的 upstream identity、独立实验开关、差异规格和行为测试。
3. 未调整命令继续由 RFC-0003 upstream adapter 提供，不发生隐式迁移。
4. 外部 command、MCP、Skill 和插件的冲突及执行行为保持 upstream 兼容。
5. fork 新增命令没有混入 upstream override 层。
6. 同步 upstream 后，override identity、metadata 或 contract drift 会在 typecheck/build/CI 阶段失败，不依赖运行时 route 或手工触发命令。
7. 所有 override 默认关闭并可在实验功能 panel 分项切换；关闭或运行时应用失败时保留 upstream handler，后者产生可见 warning 而不导致应用或命令失败。
8. `/rename <title>`、`/permissions`、`/expand`、`/collapse` 和 `/delete` 均由 toolkit 消费，不会成为 prompt、Session message 或 Agent 调用。
9. `/sessions` 可以显示并搜索 local、Rexd 和同步 metadata 所描述的执行位置，unresolved Session 不会静默消失或改为 local。
10. 实验性 Location 重绑定只暴露 RFC-0009 workflow；全局同步删除只消费 RFC-0010 domain event，不在 TUI command handler 中重复实现，也不提供 local-only 分支。
11. `/sessions` 的 Path 与 Target 筛选遵守 `Cwd => local` 约束并在本机持久化；cloud-only metadata 使用 `cloud` 标记，异步发现不会自行改变筛选值。
12. fork Core command 在 slash autocomplete、直接 submit 和 `Ctrl+P` 中由同一 registry host 发现和执行。
13. `/permissions` 分离设备 Default 与 durable Session mode；复制、迁移、持久化和同步不会意外扩大已有 Session 权限。
