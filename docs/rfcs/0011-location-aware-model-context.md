---
id: 0011
title: Location-aware Model Context
status: accepted
authors:
  - hammershock
created: 2026-09-10
updated: 2026-09-10
depends-on:
  - 0002
  - 0003
  - 0009
  - 0010
supersedes: []
superseded-by: []
---

# RFC-0011：Location-aware Model Context

## 摘要

OpenCode REXD 必须根据 Session 的实际 Location 构造模型所见的工作环境，而不能从运行 OpenCode 的控制设备隐式读取 cwd、项目根、平台或项目规则。远程 Session 的 `AGENTS.md`、兼容规则文件和项目级 `instructions` 必须从 target 文件系统发现和读取；控制端用户级规则仍代表启动 OpenCode 的用户要求。

Location 派生的环境身份和工作规则形成 Session 持久化的 `ModelContextSnapshot`。它是隐藏的系统状态，不显示成普通聊天消息，但与完整 Session 一起同步。普通 turn 不热重载已经接纳的规则；Location rebind、成功的 `/init` 和旧 Session 首次迁移可以显式产生新的上下文代际。Agent 首次进入更深目录时仍保留 OpenCode 按需追加嵌套规则的能力。

legacy TUI prompt 链与 Core V2 必须消费同一个 Location-scoped context assembler 和同一套 durable context epoch，不得继续维护两个语义不同的注入实现。

## 背景与现有缺陷

当前 TUI 通过 legacy `session.prompt` 进入 `SessionPrompt`。它虽然可以获得 Rexd Location filesystem，但规则发现的起点和终点仍来自控制端 `InstanceState`，环境提示也使用控制端 `process.platform`。结果是远程 Linux Session 可能收到 Mac 的 cwd、worktree 或 platform，并用 Mac 路径在远端文件系统查找 `AGENTS.md`，从而遗漏真正的远程工作规范。

Core V2 已经提供 Location-scoped `SystemContext`、context epoch 和 durable `ContextUpdated`，但当前活动 TUI 链没有完整采用它；初始 context baseline 也只存在于本地 epoch 表，不能保证完整 Session 跨设备同步后仍得到相同的模型上下文。两条链继续独立演进会使 local、Rexd、resume、rebind 和 sync 的行为反复分叉。

Codex 的成熟实现把 `AGENTS.md` 和 environment 作为 Session 的持久 WorldState，在明确的执行环境变化时产生有界 replacement，而不是每轮重发完整规则。OpenCode 原有的兼容文件名、`instructions` 和嵌套目录发现仍有产品价值。本 RFC 组合这些经验，但以本 fork 的 Location、Session 和同步契约为事实来源。

## 目标

1. 模型看到的工作环境与 Agent tools、User Shell 和文件工具实际使用的 Session Location 一致。
2. local 与 Rexd Location 使用同一个 model-context contract；provider 差异只存在于 Location services 内。
3. 控制端用户规则与 target 项目规则有明确的来源、顺序和读取边界。
4. 模型已经接纳的 Location context 成为可恢复、可同步、可检查的 Session 系统状态。
5. 规则在一个稳定 Session 代际内保持可复现，不因普通文件写入、重连或每轮轮询而隐式变化。
6. 保留 OpenCode 的规则文件 fallback、`instructions` 和按需嵌套规则兼容能力。
7. 远程加载复用 Rexd persistent lease，避免按目录和文件串行支付网络往返。

## 非目标

- 改变 RFC-0001 的 Agent/User Shell/Terminal scope；
- 同步 target registry、SSH 配置、凭据、workspace 文件或 `.env`；
- 把 provider 或 agent 专用基础 system prompt 冻结进 Session；
- 每轮监听或热重载普通规则文件变化；
- 引入 Codex 的 `AGENTS.override.md` 或新的 fallback 配置格式；
- 为 Rexd 增加万能远程 command API 或为本功能升级 `rexd/1` wire protocol；
- 改变远程项目配置的总体信任模型、plugin 加载或 MCP 权限；
- 在 Web/Desktop 提供 `/context` 的完整对应 UI。

## 核心概念

### Model context source

模型上下文按独立来源管理，而不是先拼成无法审计的一段字符串：

```text
provider / agent base prompt                    (model-scoped, not durable here)
  -> OpenCode REXD harness identity              (Session context)
  -> Location environment identity               (Session context)
  -> controller date and timezone                (dynamic Session context)
  -> controller-global ambient instructions      (Session context)
  -> target project instructions: root -> cwd    (Session context)
  -> nested target instructions discovered later (durable extension)
  -> other upstream dynamic context sources       (owned by their existing contracts)
```

排序表达作用域从宽到窄。更接近当前目录的规则出现在更后面。规则顺序不允许由 filesystem provider、异步完成顺序或同步到达顺序决定。

### ModelContextSnapshot

每个 Session 的当前 Location context 使用带版本的结构表示：

```text
ModelContextSnapshot {
  version
  generation
  reason: created | legacy-backfill | location-rebound | init
  locationRevision
  environment
  instructions[]
  digest
}
```

`environment` 至少包含：

- harness 名称 `OpenCode REXD` 和入口 `opencode-rexd`；
- Location provider kind：`local` 或 `rexd`；
- local portable device name 或 Rexd target 的非敏感显示名称；
- Location directory；
- target 侧发现的项目根；
- target 侧 VCS 类型；
- target platform。

不得包含控制端 hostname、控制端 cwd/platform、SSH host/IP/user/port、identity file、daemon command、credential 或 transport 诊断。local Location 的 target 环境与控制端恰好相同是 provider 结果，不是允许 remote Location 回退控制端的例外。

每个 instruction entry 至少记录稳定 source identity、origin、scope、显示路径或 URL、正文、内容 digest 和加载状态。正文是模型继续使用该代际所必需的数据；digest 只用于完整性、去重和代际比较，不能代替正文。

Snapshot 属于 Session 隐藏系统状态。它不作为普通 user/assistant message 展示，但必须通过 durable Session event 建立或替换，并由 Session projector 恢复。初始 baseline 不能只写入设备本地辅助表而缺少可同步事实。

### ContextGeneration

`generation` 是 Session model context 的单调代际，不称为 Session head，避免与 Git head 和 RFC-0010 device head 混淆。

- `created`：新 Session 在接纳首个模型输入前建立；
- `legacy-backfill`：没有 canonical snapshot 的旧 Session 第一次继续前建立；
- `location-rebound`：RFC-0009 成功提交新 Location 后建立；
- `init`：OpenCode `/init` 成功创建或更新规则后建立。

普通 prompt、TUI 切换、进程重启、冷恢复、compaction 和透明 SSH/Rexd 重连不产生新代际，也不重新读取已接纳规则。rebind 和 `/init` 是用户明确改变工作环境或规则的操作，因此是仅有的运行中 replacement 边界。

## Location 与项目边界

### Target 是唯一工作环境来源

远程 Session 的 cwd、项目根、VCS 和 platform 必须由 Rexd Location services 在 target 上解析。禁止读取控制端 `process.cwd()`、`process.platform` 或 controller-side `InstanceState.worktree` 后将其标记为远程环境。

本 RFC 消费 RFC-0002 已验证的 Location：创建可写 Session 前已经完成 target 连接、Rexd prepare/handshake、workspace root 和 directory 校验。旧 Session target 不可用时继续遵守 RFC-0009，只读打开且不能提交模型调用；model-context 层不重复实现连接校验，也不回退 local。

### 项目根发现

Rexd Location 在 target 上从 Session directory 发现最近的 Git worktree root。发现结果必须位于握手确认的 workspace roots 内。

- 找到 Git worktree：其根目录是 canonical project root；
- 没有 Git worktree：Session 创建时选择的初始 directory 是 project root；
- `workspaceRoots` 仅限定 Rexd 可访问范围，不参与项目语义选择；默认 `/` 不能导致系统从根目录扫描环境规则；
- symlink Location 保留用户可使用的逻辑 directory，同时用 target canonical path 完成包含关系、去重和越界检查。

Location rebind 必须重新执行项目发现，并把结果写入新 generation。透明 transport reconnect 不改变项目根。

## 环境身份与时间

模型环境块明确声明当前 harness 是 OpenCode REXD，而不是未修改的 upstream OpenCode。远程 Location 还必须明确声明 execution target kind 和 target name，使模型理解 Shell、文件和 Agent tools 在目标机器执行。

自然语言日期和时区看齐 Codex：每个 provider turn 从控制端系统取得当前日期和 IANA timezone。它们不暴露控制端设备身份，也不读取或显示 target timezone。日期或控制端时区变化时产生独立的有界 environment context update，不重新读取 Location 或 instruction sources。

需要 target 当前时间的任务由 Agent 在目标 Location 显式执行命令查询。

## Instruction discovery

### 全局规则

控制端全局规则代表启动 OpenCode 的用户要求，在 local 和 Rexd Session 中始终从控制端用户配置位置读取：

1. `<OpenCode user config directory>/AGENTS.md`；
2. 如果 canonical 文件不存在，保留 upstream 的 `~/.claude/CLAUDE.md` fallback。

全局规则最先加入 instruction chain。target 用户 HOME 下同名 OpenCode/Claude 全局规则不会被隐式读取；target 是执行位置，不是另一个 OpenCode controller profile。

### 项目规则

项目规则完全从 target 文件系统读取。保留 OpenCode 的 canonical/fallback 集合：

1. `AGENTS.md`；
2. canonical 类型在适用链中不存在时使用 `CLAUDE.md`；
3. 保留 deprecated `CONTEXT.md` fallback 以兼容历史项目。

从 target project root 到 Session directory 逐层发现并按宽到窄排列。禁止把控制端仓库中的同名文件作为缺失远程规则的 fallback。

### Configured instructions

`opencode.json(c).instructions` 必须保留配置 document 的来源信息，不能在 config merge 后只剩失去 origin 的字符串数组：

- 控制端用户级配置声明的文件路径和 glob 在控制端解析；
- target 项目级配置声明的文件路径和 glob 在 target 解析；
- 相对与绝对路径都遵守声明它的配置来源，不能因另一侧存在同名路径而跨边界命中；
- HTTP(S) URL 由控制端网络层获取，保留 upstream 的五秒超时；
- 同一配置中的声明顺序保持稳定；不同 scope 仍按全局到具体项目目录排序。

远程项目配置的其他字段继续服从既有 Config 契约。本 RFC 不允许 instruction loader 顺带执行 plugin、command 或 Shell 代码。

### 按需嵌套规则

如果 Agent 成功读取或列出 Session directory 以下、初始链未覆盖的子树，read/list tool 可以发现该路径适用的嵌套规则：

- 发现与读取使用同一个 target filesystem；
- 从当前已覆盖边界到目标文件目录按根到具体目录排列；
- 每个稳定 source identity 在当前 generation 中最多追加一次；
- 追加在模型读取相应工作内容之前或同一个安全工具边界完成；
- extension 是 durable Session context event，随 Session 同步；
- 后续修改已经追加的文件不会热替换它；
- 直接读取规则文件本身不能导致重复自注入。

rebind replacement 清除旧 Location 的适用 source set，并以新 Location initial chain 建立新代际。`/init` replacement 重新读取初始 chain，并保留当前 Location 已接纳但不属于 `/init` 修改范围的嵌套 source，除非它们已经不存在于同一 project boundary。

## 失败行为

Location 无法解析或 target 不可用时沿用 RFC-0002/0009，不允许模型调用。Instruction 是非关键附加来源：

- 文件、glob 或 URL 发现/读取失败时忽略该来源并继续建立 snapshot；
- 失败不得使另一侧文件系统成为 fallback；
- UI 状态栏和 `/context` 保留 source、阶段和脱敏错误；
- 普通日志记录结构化诊断，但不记录 rule body；
- 失败来源本代际内不后台热重试；下一次明确 generation boundary 才重新加载；
- 空文件视为可用但不产生 model-visible instruction body。

异步任务完成顺序不得改变成功来源的规范排序。

## 持久化与同步

建立、替换和扩展 model context 的事件属于完整 Session durable stream，必须被 RFC-0010 capture、externalize、hydrate 和 projector 回放。同步后的设备直接使用 Session 已接纳的 snapshot，不读取该设备自己的全局规则或重新抓取 target 文件来改写历史代际。

同步必须包含模型继续执行所需的 context body。RFC-0010 v1 继续信任百度网盘存储层保护，本阶段不因缺少应用层端到端加密排除 model context；未来增加加密必须迁移完整 Session payload，而不能只加密普通聊天消息。

以下内容仍不进入同步：target registry、SSH 配置、凭据、`.env` 值、普通 workspace 文件和 provider/agent 私有基础 prompt。

并发 context event 使用 Session aggregate sequence 和 RFC-0010 的既有分叉规则。同步到达顺序不能改变 instruction order。重复 event/digest 必须幂等。Location rebind event 与对应 context replacement 必须处在同一个可恢复 transaction boundary；在 replacement 可用前不得接纳下一条模型输入。

## `/context` 检查入口

新增可信 Core command `/context`，使用 RFC-0003 command toolkit 注册。它是 control-plane inspector：不触发模型、不进入 Session transcript 或模型上下文，也不修改 generation。

TUI 面板使用本 fork 的视觉规范，默认展示：

- 当前 generation、生成原因和 Location revision；
- harness 与 target identity 摘要；
- 按实际注入顺序排列的 source；
- 每项的 origin、scope、显示路径/URL、digest 摘要和 loaded/ignored 状态；
- ignored source 的脱敏失败阶段。

用户聚焦 source 后按 Enter 预览 Session 中冻结的准确正文。面板不展示 provider/agent 基础 prompt，不自动连接 target，不重新抓取 URL，不提供编辑或 refresh。长路径和错误使用聚焦详情，不破坏列表布局。

## 远程性能与状态栏

初始 prompt 可以等待 canonical snapshot，但 remote provider 必须满足：

1. 复用 RFC-0002 prepare 后的 Rexd connection lease，不为 context discovery 建立新的 SSH 连接；
2. Git root discovery 是一个有界 target operation；
3. 已知 project root 后，ancestor candidate stat/glob 使用同一连接并发发送，不按目录串行等待 RTT；
4. 成功文件 read 使用有界并发，URL fetch 与 target filesystem 工作并行；
5. 不下载或递归枚举项目树，不预加载 cwd 以下所有规则；
6. 不增加 `rexd/1` 专用 context RPC，也不通过 Shell 字符串拼接建立通用执行后门。

所有 Rexd context discovery/read 都通过既有右上角状态栏显示 target、阶段和当前 source 摘要。完成后立即消失；失败时保留可展开的详细诊断，并遵守本 RFC 的非阻塞规则失败策略。

## 实现边界

- Core 提供 canonical model-context assembler、schema、epoch transaction 和 inspector workflow；
- Config loader 暴露 instruction entry 的 document origin 和 scope；
- Location provider 提供 platform、project discovery 和 filesystem 能力；
- Rexd adapter 只实现 Location 能力和并发调度，不拥有 Session persistence；
- Session runner 在 durable input admission 前保证初始/replacement generation 已提交；
- legacy HTTP/TUI prompt 入口必须进入同一 Session workflow，不能继续直接拼接 controller-side `Instruction.system()`；
- TUI 只呈现 `/context` 和 remote operation state，不解析规则或直接访问 target filesystem；
- sync adapter 只传输正式 durable event，不直接写 context epoch 表。

## 兼容与迁移

1. local Session 保持 upstream 可观察的规则来源、fallback 和 `instructions` 能力，顺序统一为 global、project root、cwd。
2. 远程 Session 不再接受 controller project path/platform 的历史错误行为。
3. 没有 canonical snapshot 的旧 Session 在第一次可写继续前执行一次 `legacy-backfill`；失败的规则来源按本 RFC 忽略，Location 不可用仍进入 RFC-0009。
4. 已有 Core V2 context epoch 迁移为 canonical durable snapshot；不得把同一初始内容重复投影为聊天消息。
5. 已同步但没有 baseline 的旧 Session 由首先继续它的设备产生一次正常 durable backfill；并发 backfill 通过 aggregate sequence 收敛或按既有分叉规则处理。
6. model/agent switch 不产生 Location context generation；provider/agent 基础 prompt 继续使用 upstream 当前选择。
7. compaction 保留当前 snapshot 和 extension 的语义，不重新读取来源，也不重复插入正文。

## 验收条件

1. 控制端和 target 使用故意不同的 cwd、项目根与 platform 时，录制的远程模型请求只包含 target 工作环境；控制端项目规则不会混入。
2. local 与 Rexd 通过同一个 assembler 产生相同 schema，并分别从正确 filesystem 读取 source。
3. target 侧 Git root、非 Git fallback、workspace root 分离和 symlink Location 均有 contract test。
4. 全局规则、项目 `AGENTS.md`、OpenCode fallback、全局/项目 `instructions`、glob 和 URL 的来源及顺序有测试。
5. 初始链和按需嵌套链都按根到具体目录排序；重复 read/list 不重复追加。
6. new、legacy-backfill、rebind 和 `/init` generation 均 durable、幂等，并在 prompt admission 前完成；普通 turn、重启和透明重连不读取规则。
7. context baseline、replacement 和 extension 可以通过 RFC-0010 在 Mac 与 `mywindows` 双向同步，另一设备构造的模型请求使用相同正文、顺序和 digest。
8. `/context` 展示实际 snapshot 与 ignored diagnostics，正文预览准确，且命令不触发模型、网络、target 连接或 Session transcript。
9. 文件、glob 和 URL 失败不会阻止模型调用，不会跨 filesystem fallback，状态栏和日志提供脱敏原因。
10. target identity 只包含允许字段；SSH 连接信息、credential、`.env` 和控制端设备身份不进入模型上下文或同步 payload。
11. 控制端日期与 IANA timezone 每轮可用，跨日只产生 time context update，不触发规则重载；target timezone 不注入。
12. Rexd contract test 证明 initial discovery 复用现有 lease，ancestor/read 请求并发且没有逐文件 SSH handshake。
13. package-local typecheck、unit/contract/integration tests 通过；Mac 和 `mywindows` 使用同一提交构建的 `opencode-rexd` 完成 local、Mac→Linux target、mywindows→Mac target 和跨设备 resume 实测。

## 参考

- [Codex：Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [Codex PR #29810：make AGENTS.md react to environment changes](https://github.com/openai/codex/pull/29810)
- [Codex issue #3198：AGENTS.md should be reloaded on each turn](https://github.com/openai/codex/issues/3198)
- [Codex issue #16403：refresh project instructions across turns](https://github.com/openai/codex/issues/16403)
- [OpenCode rules documentation](https://opencode.ai/docs/rules/)
