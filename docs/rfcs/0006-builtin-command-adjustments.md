---
id: 0006
title: Built-in Slash Command Adjustments
status: draft
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-06
implemented-by: []
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

对上游内建命令的调整必须通过 RFC-0003 toolkit 的显式 override/decorator 机制实现，不直接修改通用 prompt dispatch，也不复制整段上游 handler。

每个 override 必须具有：

- 稳定的 fork command identity；
- 被调整的 upstream command identity 和 baseline version；
- 原 handler 的兼容 fallback 或可复用调用入口；
- 明确的参数、客户端和 route 范围；
- 行为差异测试；
- upstream 同步时的 drift 检测。

如果 upstream command identity 或 contract 发生变化，override 必须显式进入 incompatible 状态并要求重新审查，不能静默绑定到名称相同但语义已经变化的新命令。

## 从旧归档恢复的调整候选

以下内容来自旧归档实现。它们是本 RFC 的待确认规格，不代表应直接复制旧代码。

### `/exit`：Session 内返回 QuickStart

Upstream baseline：TUI 中 `/exit`、`/quit`、`/q` 直接退出应用。

候选调整：

- 当前 route 是 Session 时，slash command 返回 QuickStart/home，不终止 OpenCode；
- 当前已经位于 home 时，slash command 退出 OpenCode；
- `/quit` 和 `/q` 与 `/exit` 保持一致；
- 专用“立即退出应用”keybind/command 保持 upstream 行为，不被 route-sensitive slash override 替换；
- 该操作不写入 Session、不进入模型上下文、不调用 Agent。

旧实现通过拆分 `app.exit` 与 `route.exit` 达成该语义。新实现应使用 toolkit decorator 和共享导航 action，不在 prompt submit 中识别字符串。

### `/rename [title]`：支持直接重命名

Upstream baseline：TUI `/rename` 打开重命名 dialog。

候选调整：

- `/rename` 不带参数时保持原 dialog；
- `/rename <title>` 将参数剩余部分作为完整标题直接更新；
- 只裁剪标题首尾空白，保留内部空格和 Unicode；
- 没有当前 Session 时不执行，并显示明确提示；
- 不写入对话、不进入模型上下文、不调用 Agent；
- 同步功能通过 Session rename domain event 观察变化，command 本身不直接依赖百度网盘实现。

### `/sessions`：显示并搜索执行位置

Upstream baseline：打开 Session 列表并进行选择。

候选调整：

- 保留原选择、固定、排序和快捷键行为；
- 为存在相关 metadata 的 Session 显示 `device · target · cwd`；
- 搜索覆盖标题、device、target 和 cwd；
- 未配置 Rexd 或同步时退化为 upstream 信息，不显示虚假占位；
- 云端 Session 的发现、只读打开和 ownership 规则由后续同步 RFC 定义；
- `/sessions` 只调用可复用 Session query service，不直接实现云端下载或冲突处理。

### `/models`：增加 provider 使用量信息

Upstream baseline：打开模型选择 dialog，并展示收藏和 provider 分组。

候选调整：

- 收藏模型按 provider 分组；
- provider 标题旁显示能够可靠查询到的余额或订阅剩余额度；
- dialog 打开时并发查询已连接 provider，并使用短时缓存；
- 提供显式刷新 action 绕过缓存；
- 不支持可靠查询的 provider 不显示推测值；
- 查询失败不阻止模型选择，也不把认证信息写入 Session 或模型上下文。

Provider usage API、缓存、安全和 provider-specific adapter 需要单独设计；本 RFC 只规定 `/models` 的用户可见行为。

### `/variants` 及 variant 操作

Upstream baseline：`/variants` 打开当前模型的 variant 选择；另有循环 variant 的 keybind command。

旧归档还增加了提高/降低 reasoning effort 的 keybind，并为特定模型提供默认 effort 基线。这不完全是 slash override，但会改变 `/variants` 所呈现状态，因此记录为关联候选：

- `/variants` 仍只展示 provider/model 明确支持的值；
- increase/decrease 按 provider 声明的有序 variants 移动，不猜测不存在的 effort；
- 模型专用默认值必须来自统一 model metadata/config，不能在 TUI command 中硬编码 model ID；
- 是否保留这一调整需要在本 RFC 接受前确认。

## 旧归档中的新增命令

以下命令不是当前 upstream baseline 的内建命令，因此不属于 override：

- `/target`、`/cd`；
- `/env`；
- `/sync`、`/devices`；
- `/permissions`；
- `/expand`、`/collapse`；
- `/delete`。

它们必须作为新的 Core command 通过 RFC-0003 toolkit 实现，并分别归属对应功能 RFC。不能为了复用旧逻辑而把它们登记为 upstream built-in adjustment。

## 默认兼容策略

- 未列入“已接受调整”的上游内建命令保持 baseline 行为。
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
8. upstream handler/schema drift 检测。

不要在同一个实现提交中同时调整多个无关的上游命令。

测试应从 registry 的结构化 metadata 生成 baseline snapshot；不要另写一份只验证命令名称的手工列表。RFC 中的清单用于设计审查，snapshot 用于在同步 upstream 时发现实际注册表变化。

## 待确认问题

1. 是否接受 `/exit` 的 route-sensitive slash 行为，同时保留立即退出 keybind？
2. `/rename <title>` 是否只接受单行标题，还是保留完整多行参数？
3. `/sessions` 的跨设备发现是否完全由未来同步 RFC 提供，本 RFC 只消费 metadata？
4. 是否仍需要 `/models` provider usage 功能，哪些 provider 属于首批可靠支持范围？
5. reasoning effort increase/decrease 是否纳入本 RFC，还是进入单独的模型交互 RFC？
6. 上述调整哪些需要 Web/Desktop parity，哪些明确只属于 TUI？

## 验收条件

1. 上游内建清单与固定 baseline 的源码注册结果一致。
2. 每项已接受 override 都有明确的 upstream identity、差异规格和行为测试。
3. 未调整命令继续由 RFC-0003 upstream adapter 提供，不发生隐式迁移。
4. 外部 command、MCP、Skill 和插件的冲突及执行行为保持 upstream 兼容。
5. fork 新增命令没有混入 upstream override 层。
6. 同步 upstream 后可以通过测试或诊断明确发现 override drift。
