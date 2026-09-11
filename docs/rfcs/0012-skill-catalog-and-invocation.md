---
id: 0012
title: Skill Catalog, Structured Invocation, and Sync
status: accepted
authors:
  - hammershock
created: 2026-09-11
updated: 2026-09-11
implemented-by:
  - https://github.com/hammershock/opencode-transit/pull/280
  - https://github.com/hammershock/opencode-transit/pull/281
  - https://github.com/hammershock/opencode-transit/pull/282
depends-on:
  - 0002
  - 0003
  - 0010
  - 0011
supersedes: []
superseded-by: []
---

# RFC-0012：Skill Catalog、结构化调用与同步

## 摘要

OpenCode 必须把 Skill 作为结构化能力，而不是把完整 `SKILL.md` 注册成普通 slash command template。用户在 normal prompt 中输入 `$` 可以搜索并 mention Skill；提交后，原始用户请求与 Skill invocation 保持独立，Skill 正文不会参与 `$ARGUMENTS` 或 `$1` 替换。TUI 只显示 `$skill` token 和默认折叠的 Skill context 行，模型仍收到完整指令。

Skill package、发现路径和 target 适用范围由控制设备拥有，不复制到 Rexd target。账户同步可以显式开启 OpenCode Skill sync，但只同步 OpenCode 用户配置目录 `skill/` 与 `skills/` 中的完整 Skill package；Codex、Claude、自定义 imported roots、project Skill、built-in Skill 和 target scope 均保持 device-local。每个 Skill 默认适用于全部 execution target，用户可以在统一设置入口中改为 `local` 与具体 target ID 的名单。Rexd Agent 如需访问 Skill 的辅助文件，使用有界、只读的 controller-side resource tool；它不能在控制设备执行脚本，也不能把控制设备目录伪装成 Session Location。

Agent 可用 Skill 的元信息在 Session model context 初始化时接纳一次，普通 provider turn 不重新扫描。新建、resume 或切回 Session 时执行一次强制 catalog reload；变化通过 RFC-0011 当前 Context Generation 内的隐藏 context advance 生效，不重写原始 system baseline，也不建立新的 Location generation。显式或隐式加载的 Skill 正文形成隐藏、可展开的 durable invocation snapshot，并随完整 Session 同步，以保证跨设备续聊使用已经接纳的准确内容。

## 背景与现有缺陷

当前 legacy 路径同时把 Skill 当成三种不同对象：

1. `Session.system()` 把全部 Skill 的 name、description 与路径拼入 system prompt；
2. `SkillTool` 通过 `skill({ name })` 返回完整 `<skill_content>`；
3. command registry 又把每个 Skill 注册为 slash command，并以完整 Skill 正文作为 command template。

第三条路径使 `/<skill> request` 先对原始 Skill 正文执行 `$ARGUMENTS` 与 positional argument 替换，再把长正文投影成普通 user text。结果是用户请求可能被 Skill 文档中的示例占位符吞掉，或者被追加在长文档末尾；TUI、复制、fork 和 transcript 也把正文误认为用户输入。隐式 `skill` tool 虽然不会破坏用户请求，完整输出仍占据大量会话空间并暴露在普通时间线中。

Core V2 已有 Location-scoped `SkillV2`、`SkillGuidance`、model `skill` tool 与 RFC-0011 的 durable Context Epoch，但当前 catalog cache 没有明确的 Session activation reload 边界，`SkillGuidance` 仍按普通 turn context source 建模。它既不能稳定表达“会话内冻结、重进会话刷新”，也没有结构化 mention、控制侧资源 authority 或 per-target availability。

Codex 的可观察行为提供了合适的交互基线：composer 发送结构化 Skill input，完整 Skill 指令成为与用户文本分离的 contextual fragment；TUI 在 thread/session configured 时以 force reload 获取当前 catalog。OpenCode 不复制 Codex 内部对象模型，但采用相同的产品语义，并复用本 fork 已有的 Session Context Generation 与 durable event，而不是另建内存 prompt 拼接链。

## 目标

1. normal prompt 支持可搜索、可验证的 `$skill` mention，并保持用户请求为一等输入。
2. 显式 mention、implicit tool 与 legacy slash compatibility 最终使用同一个 canonical Skill catalog 和 invocation snapshot。
3. 普通时间线默认隐藏 Skill 正文，同时允许用户查看模型实际接纳的准确快照。
4. 默认只发现 OpenCode-owned roots；Codex、Claude 与自定义目录必须显式导入，并可一键 reset。
5. Skill 元信息只在 Agent context 初始化或 Session activation reload 时接纳，不在每个 turn 扫描磁盘。
6. 新 Skill 在退出并重新进入 Session 后可被 TUI 和 Agent 发现，不要求重启 OpenCode。
7. Skill 设置与非 OpenCode roots 保持 device-local；用户可显式同步 OpenCode global Skill package，已调用正文仍作为 Session context durable 同步。
8. 每个 Skill 可以按稳定 target identity 限定适用范围，默认包括全部当前及未来 target。
9. Rexd Session 可以安全读取 controller-owned Skill 的文本资源，但不能因此获得隐式控制机执行权限。

## 非目标

- 同步 Codex、Claude、自定义 imported root、project Skill、built-in Skill 或 target scope 配置；
- 自动复制或安装 Skill 到 Rexd target；
- 在控制设备执行 Skill 脚本，或为 Skill 绕过 RFC-0001/0002 的 Agent execution scope；
- 在活跃 Session 中监听文件并热更新 catalog；
- 为 Web/Desktop 实现完整 Skill manager；
- 新增远程 Skill marketplace、安装协议或 URL source 格式；
- 把 Skill sync 扩展为任意目录或通用文件同步；
- 使未调用 Skill 的完整正文进入初始 model context；
- 将 Skill 指令视为保密数据。显式调用后，正文会发送给当前 model provider，并按本 RFC 进入 Session sync。

## 核心概念

### Controller-owned Skill Registry

Skill Registry 是控制设备本地的发现与策略事实来源。它组合：

- OpenCode built-in Skill；
- OpenCode native filesystem roots；
- 用户显式导入的 controller filesystem roots；
- 为上游兼容保留的显式 URL source。

Registry 不属于 Session aggregate。它的 roots、diagnostics、target policy 与 cache 不进入 RFC-0010 sync；只有本 RFC 明确定义的 OpenCode global Skill package 由独立 Skill sync projection 传输。TUI 只能通过 Core/Server 的 typed registry workflow 查询或更新 Registry，不能直接扫描目录或修改配置文件。

每个发现结果具有 device-local、稳定的 `SkillID`。filesystem Skill 使用 `skl_` 加 source kind、canonical root 与 root-relative `SKILL.md` path 的 SHA-256 digest；built-in Skill 使用其 package identity 计算。ID 不直接编码路径，root reorder 不改变 ID；移动 root 或 Skill file 会形成新 identity。`SkillID` 不作为跨设备可移植 identity，也不能从 synced Session payload 中反推出控制设备绝对路径。

name 是用户和 Agent 的显示 alias，不是唯一 identity。重名 Skill 可以同时存在：结构化 mention 绑定 `SkillID`；手工输入的 bare `$name` 和仅按 name 的 legacy/tool 请求只有在当前可用 catalog 中唯一时才可解析，否则必须返回候选来源而不能按扫描顺序静默选择。

### Skill Catalog Snapshot

Catalog 是某次 Session activation 为一个 target 和 Agent selection 解析出的可用元信息快照：

```text
SkillCatalogSnapshot {
  revision
  target
  agent
  skills[] {
    id
    name
    description?
    sourceLabel
    digest
  }
  diagnostics[]
  digest
}
```

`sourceLabel` 用于区分重名条目，但进入 durable Session context 时必须脱敏；controller absolute path 只存在于 device-local registry response。catalog 不含完整 Skill body 或辅助资源内容。

target scope 先过滤 catalog，Agent skill permission 再过滤结果。被 target scope 或 permission 排除的 Skill 不出现在 `$` picker、model metadata 或 implicit load resolver 中。

### Skill Invocation Snapshot

一次显式 mention 或隐式 `skill` tool load 产生：

```text
SkillInvocationSnapshot {
  invocationID
  name
  digest
  sourceLabel
  content
}
```

`invocationID` 是 Session-scoped identity，不是 device-local `SkillID`。snapshot 在 prompt admission 或 tool completion 的 durable transaction 中建立。模型消费 snapshot 的 `content`，后续 replay、compaction、fork 和 sync 使用同一正文，不重新读取可能已经变化或消失的 controller file。

invocation snapshot 是用户已经选择进入会话的 model context，因此始终跟随 RFC-0010 的完整 Session payload，不依赖 Skill sync 是否开启。Session 同步端不得包含 device-local `SkillID`、controller absolute root、未调用资源清单或 target-scope 配置。另一设备即使没有安装该 Skill，也可以显示并继续使用已经接纳的正文；读取尚未进入 Session 的辅助资源要求当前控制设备按 snapshot 的 name 与 content digest 找到唯一完全匹配的本地 Skill。OpenCode global Skill package 的独立同步语义见下文。

## 默认发现范围

默认启用的 OpenCode-owned roots 只有：

1. OpenCode embedded/built-in Skill；
2. `<OpenCode user config directory>/skill`；
3. `<OpenCode user config directory>/skills`；
4. local Location 从 project root 到 Session directory 适用的 `.opencode/skill` 与 `.opencode/skills`。

第 4 项只适用于 local Location，因为它的 project filesystem 与控制设备相同。Rexd Session 不扫描 target 的 `.opencode`、`.claude`、`.agents` 或 `.codex`，也不能用控制设备上不相关的同名 project path 代替。Rexd Session 使用控制设备 global roots 与显式 imported roots，再按 target scope 过滤。

不再默认扫描：

- `~/.claude/skills`；
- `~/.agents/skills`；
- `${CODEX_HOME:-~/.codex}/skills`；
- project 中的 `.claude` 或 `.agents` roots。

现有 `skills.paths` 与 `skills.urls` 属于显式配置，升级后继续作为 imported sources 出现，不能静默丢失。URL source 继续使用 upstream cache 和安全校验，但 v1 TUI 不提供新增 URL 的入口；用户仍可手写兼容配置。

所有 filesystem roots 在控制侧展开 `~`、解析绝对路径并使用 canonical/real path 去重。不存在、不可读或解析失败的 root 保留稳定诊断，不阻止其他 root 建立 catalog。扫描顺序不得成为重名解析规则。

## OpenCode Skill package sync

### 与 RFC-0010 的关系

RFC-0010 的 v1 payload scope 只有 Session。本 RFC 在不改变账户、provider、manifest、leader、outbox、manual/automatic sync 和 cloud reset 产品模型的前提下，增加第二种 provider-neutral payload：OpenCode global Skill package。

Skill sync 复用已连接的账户、当前 cloud instance、device identity、single-writer leader、immutable object、transactional outbox、checkpoint、retry 和 acknowledgement 基础设施。它不创建第二个账户、sync space、worker 或 provider login，也不把 Skill 文件塞进 Session event stream。

RFC-0010 中配置、target registry、credential、workspace 与 UI state 不同步的约束继续成立。Skill package 是本 RFC 特许的独立同步 domain，不代表 `opencode.json(c)` 或任意配置目录获得通用同步能力。

### 同步范围与启用

每台设备增加 device-local 的 `OpenCode Skills` sync setting，默认关闭，包括升级前已经启用 Session automatic sync 的设备。只有用户在 `/sync` 或 `Manage skills` 中明确开启后，本设备才 inventory、上传或下载 Skill package。新设备必须独立 opt in；看到 cloud manifest 中存在 Skill 数据不等于允许下载。

`OpenCode Skills` 决定该 data type 是否参加同步；RFC-0010 的 `Automatic sync` 继续决定后台 worker 是否自动传输。automatic sync 关闭时，Skill 变更仍进入 durable local outbox，显式 `Sync now` 可以处理它们，之后可从 checkpoint 继续。

同步范围严格限定为控制设备上的：

```text
<OpenCode user config directory>/skill/**/SKILL.md
<OpenCode user config directory>/skills/**/SKILL.md
```

一个 `SKILL.md` 所在目录构成一个 package root。同步整个 package 中的普通文件，使 scripts、references、templates 与 assets 可以在另一设备恢复。package 内出现嵌套 `SKILL.md` 时，nested directory 是独立 package，parent package manifest 排除整个 nested package subtree，避免一个文件被两个 package 拥有。

以下内容即使已被 catalog 发现也不进入 Skill sync：

- embedded/built-in Skill；
- local project 的 `.opencode/skill` 与 `.opencode/skills`；
- Codex、Claude、`.agents` 与任意 imported filesystem root；
- URL source 及其 cache；
- discovery root、target scope、permission 与其他配置；
- symlink、socket、device、FIFO 和 package root realpath 以外的文件；
- Skill sync 自己的 staging、conflict、trash、journal 与 metadata。

判断依据是文件的 canonical ownership，而不是 Skill name。把 Codex path 作为 imported root 不会使其同步；把 package 明确移动到 OpenCode global root 后，它才在下一次成功 inventory 中进入范围。两个 canonical OpenCode roots 均保留，云端 logical path 记录 `skill` 或 `skills` root kind 与 POSIX relative path，不包含设备绝对 config path。

开启前，TUI 必须说明完整 package 会上传到当前 RFC-0010 storage provider，可能包含指令、代码和资源，而且 v1 沿用 RFC-0010 的 provider-side protection、没有应用层端到端加密。开启是同步授权，不代表 Skill 自动获得 Agent permission 或 target access。

### Package snapshot 与云端布局

Skill sync 以 package 为原子一致性边界：

```text
SkillPackageKey {
  root: "skill" | "skills"
  path: PortableRelativePath
}

SkillPackageVersion {
  key
  operationID
  authorDeviceID
  parentVersions[]
  manifestDigest
  files[] {
    path
    size
    digest
    blob
  }
}
```

package key 使用规范的大小写敏感 POSIX relative path。provider adapter 不按远端 filesystem 规则折叠大小写；写入 macOS/Windows 大小写不敏感目录前必须检测 collision，并把它提升为 conflict，不能覆盖任一 package。

manifest 与 content-addressed blobs 是 immutable object。per-device head 引用 Skill operations；control projection 记录当前 package version set、resolution 与 tombstone。相同 digest 的文件跨 package 去重，但 GC 只能在全部 live manifest、conflict、outbox 与 acknowledgement 都不再引用 blob 后删除它。

不得把整个 Skill root 打成一个 mutable archive。一个 package 的失败、冲突或大文件不能阻止其他 package 增量同步。package version 必须完整验证 manifest、size 与 digest 后才能进入 projection。

### Local inventory 与原子应用

开启 Skill sync 时先 inventory 两个 OpenCode roots 并为既有 package 建立 durable outbox。以后以下动作可以触发有界 inventory：

- OpenCode 启动与 Skill sync enable；
- `Sync now` 与 automatic maintenance；
- controller filesystem watcher 的 change hint；
- Session activation 的 Skill force reload。

watcher 只提供失效提示，不能直接发布 cloud operation。一次 scan 必须成功完成 root enumeration，并为每个 package 获得稳定 manifest；读取期间发生 size/mtime/digest 变化时重试该 package，不上传部分 snapshot。root 暂时不可读、scan 被取消或超过资源限制不产生删除。

remote package 先下载到 OpenCode config 外的同 filesystem staging directory，逐文件验证后再 atomic rename 到 logical destination。目标设备在 commit 前不能发现半个 package。commit 成功后 invalidate controller Skill Registry；当前活跃 Session 继续使用 admitted catalog，重新进入后按本 RFC activation reload 发现新版本。

Skill sync 写入使用进程间 lease 和 per-package lock，与 external editor 保存、manager mutation 及另一个 OpenCode 进程串行化 commit。无法取得 lock 时保留 pending，不把 busy 当作失败或回退到非原子覆盖。

单文件与 package 使用明确、有界的 size/count/path limits，并复用 RFC-0010 attachment/blob chunking。超过限制的 package 保持 local，显示 `! too large` 及具体 limit，不截断、不上传不完整内容，也不阻塞其他 package。limit 是公共 capability metadata，所有设备对同一 protocol version 使用相同值。

### 并发、冲突与删除

package version 使用 parent set 表达因果关系：

- remote version 是 local current version 的 descendant 时，可以原子快进；
- local version 是 remote descendant 的 ancestor 时，不覆盖 newer local state；
- 两个版本都不是对方 descendant 时形成 multi-value conflict，不执行 last-writer-wins；
- 相同 manifest digest 幂等合并，不产生 conflict。

发生 conflict 时，当前设备已有的 package 保持 active；其他完整版本保存在 `<OpenCode state>/skill-sync/conflicts`，不放进被同步 roots，也不自动进入 Agent catalog。没有 local active version 的新设备保持该 package unavailable，直到用户解决冲突。`/sync` 与 `Manage skills` 都深链到同一个 conflict workflow，提供：

- `Keep current`：发布选择当前 version 的 resolution；
- `Use incoming`：先把当前 package 移入 recoverable conflict archive，再原子应用 incoming version 并发布 resolution；
- `Keep both`：要求用户选择一个尚未占用的 OpenCode-root relative directory，将 incoming version 作为新 package materialize；frontmatter name 不自动改写，catalog 通过 `SkillID` 正确表示重名。

resolution 是带 expected version set 的 durable control operation。迟到 resolution 或目录已被占用时拒绝并刷新视图，不能覆盖新的编辑。其他设备投影 resolution 后收敛到相同 package set。

已知 package 在一次完整成功 inventory 中消失时产生 tombstone。remote tombstone 只有在 local package 仍等于被删除 ancestor 时才能应用；先把目录移到 `<OpenCode state>/skill-sync/trash`，再提交 local projection。与删除并发的本地编辑形成 conflict，不被删除。

tombstone 使用 RFC-0010 相同的 remove-wins acknowledgement 与 GC 原则。离线设备的旧 head、旧 manifest 或 pending update 不能复活已经确认的删除。trash 至少保留到本设备对删除发布 replacement head 与 acknowledgement；cloud GC 完成不要求永久保留 local trash，但任何清理都必须限定在 managed trash，不能递归删除 OpenCode config root。

### Sync UI 与状态

`/sync` 在现有 account 与 automatic sync 行下增加：

```text
OpenCode Skills     Off / On
Skill packages      12 ready · 1 conflict
```

状态统计只包括两个 eligible roots。imported Skill 在 `Manage skills` 中明确显示 `local only`；eligible package 显示 `local only`、`pending`、`syncing`、`ready`、`conflict` 或 `attention`。状态使用共享右上角 sync operation indicator，不能启动第二个 worker 或独立 progress overlay。

开启、关闭、manual sync、conflict resolution 和 cloud reset 均通过 Core workflow。关闭只停止新的 Skill inventory/transfer，不删除本地 package、cloud objects 或已有 outbox。重新开启从原 checkpoint 继续。

RFC-0010 的 `Clear cloud sync data` 同时清除当前 cloud instance 下的 Session 与 Skill namespaces，确认文案必须明确列出二者；它仍保留所有本地 Session 与 Skill package 并关闭 automatic sync。logout/revoke 同样保留本地 Skill。只清除 Skill cloud data 的独立破坏性入口不属于 v1。

## Skill 设置与 target scope

### 配置模型

现有 global Skill 配置扩展为：

```text
skills {
  paths?: string[]
  urls?: string[]
  targets?: Record<SkillID, "*" | ("local" | TargetID)[]>
}
```

`targets` 缺项等价于 `"*"`。显式空数组表示在全部 target 禁用。`"*"` 自动包括以后新增的 target；显式列表不会因 target rename、remove、restore 或新增而变化。

target display name 不能作为 identity。已移除的 ID 在 manager 中显示 `! missing`，不得被删除、同名 target 或 `local` 自动替换，也不能使 scope 回退为 `"*"`。重新恢复相同 target ID 后配置重新生效。

target scope 只能由 controller-global config 声明。project config 可以继续声明 project-local Skill source，但不能写入 device-local Target ID。project 中出现 `skills.targets` 时忽略该字段并产生来源明确的诊断。

### TUI workflow

`Ctrl+P` 注册一个 `Manage skills` command，并与 `/skills` 进入同一个 Core-owned workflow。面板遵守 `docs/ui-design-guidelines.md`：固定右侧 status、长路径只在 focused detail 展开、异步 refresh 不重排 selection，不使用 emoji。

主视图分为：

```text
Discovery paths
  OpenCode config                         ● default
  ~/.codex/skills                         ● ready
  ~/.claude/skills                        ! unavailable

Skills
  imagegen                                all targets
  deploy                                  2 targets
```

提供以下 actions：

- `Add path...`：使用 controller filesystem path completion；
- `Import Codex skills`：解析 `${CODEX_HOME:-~/.codex}/skills`；
- `Import Claude skills`：解析 `~/.claude/skills`；
- `Remove path`：只移除引用，不删除目录或 cache；
- `Reset discovery paths`：清除 imported paths 与 configured URLs，使有效范围只剩 OpenCode defaults；不删除任何文件；
- `Target access...`：为 focused Skill 选择 `All targets` 或 `local` 与已配置 Rexd targets 的 checklist。

Reset 改变明确的用户配置，需要一次说明影响范围的确认。它只重置 source list；暂时无法发现的 Skill target overrides 保留为 dormant entries，使重新导入同一 `SkillID` 后恢复原 scope。面板可以单独清理 dormant override，但 reset 不隐式执行该操作。

Registry mutation 使用与 target registry 相同的 revision/CAS、原子写入和未知 JSONC 字段保留要求。正常 save 不弹额外确认；revision conflict 保留面板与 selection，刷新后要求用户重新应用。

设置保存后只 invalidate device-local registry cache。当前活跃 Session 的 admitted catalog 不热更新，TUI 显示简短提示，说明重新进入 Session 后生效。

## `$skill` 结构化 mention

### Composer 语义

normal prompt 中，在 token boundary 输入 `$` 打开 Skill autocomplete。候选来自当前 Session 已接纳的 catalog；没有 Session 时使用 QuickStart 当前选择的 target 与 Agent preview catalog。candidate row 显示 name、单行 description 与必要的 source label。

选择候选后，composer 插入可编辑显示为 `$name` 的 extmark，并保存非文本 part：

```text
SkillMention {
  id: SkillID
  name: string
  source { start, end, text }
}
```

删除或改写 token 会删除绑定 part。paste、history restore、external editor round-trip、undo 和 draft restore 必须像 file/agent parts 一样重建或移除 extmark，不能留下幽灵 invocation。

以下输入不触发 Skill：

- Shell mode 中的 `$PATH`、`$HOME` 等变量；
- escaped `\$name`；
- email、普通单词内部或没有 catalog match 的 `$text`；
- code span 中未由 picker 建立 structured part 的文本。

submit 时，structured part 优先。没有 part 的 bare `$name` 可以在 token boundary 按当前 catalog fallback 解析，但仅允许唯一名称；ambiguous name 阻止提交并重新打开候选选择。不存在的 `$name` 保持普通文本，不创建 Skill invocation。

同一 prompt 的多个 Skill 按 mention 首次出现顺序注入；同一 `SkillID` 重复 mention 只产生一个 snapshot，但用户文本保持原样。

### Durable admission

TUI 只提交 `SkillMention` identity，不读取 `SKILL.md`。Server 在 durable prompt admission 前完成：

1. 依据当前 admitted catalog 验证 SkillID、target scope 与 Agent permission；
2. 从 controller registry 读取完整 Skill body；
3. 验证当前 digest 与 mention catalog digest；
4. 将用户 prompt、mention identity 和 invocation snapshot 原子接纳；
5. 再调度 Session execution。

如果 Skill 在选择与提交之间变化，提交返回 typed stale-catalog error，不用新正文悄悄替换用户选择。TUI refresh 当前 catalog，保留用户文本，并要求用户重新选择对应 mention。读取失败同样不创建半完成 prompt。

Skill 正文作为与用户文本分离的 contextual user fragment 发送给模型。它不能拼接进 `Prompt.text`，也不能经过 command placeholder parser。用户请求在 fragment 顺序中保持独立且位于 Skill instructions 之后，使模型明确区分 workflow 与 task。

### Slash compatibility

现有 `/<skill-name> arguments` 在兼容期保留，但 command resolver 不再把 Skill body 作为 template：

- 唯一 Skill name 转换为一个 structured mention；
- `arguments` 原样成为用户 prompt；
- Skill body 中的 `$ARGUMENTS`、`$1` 等保持字面量；
- ambiguous Skill name 显示候选，不按 source order 选择；
- `/skills` 不再把 `/<skill>` 写入 composer，而是插入 `$skill` mention。

普通自定义 command 继续使用既有 placeholder 语义。Skill compatibility adapter 与 command toolkit 分离，避免改变非 Skill command。

## Catalog 生命周期与 Context Epoch

### 初始化一次

`core/skill-guidance` 改为 activation-scoped System Context source。它不参加 ordinary-turn reconcile。

新 Session 在接纳首个模型输入前：

1. force reload controller Skill Registry；
2. 按 Session target 和 selected Agent permissions 构造 catalog；
3. 把有界 name/description metadata 写入 RFC-0011 generation baseline 与 structured snapshot；
4. 记录 catalog digest。

“初始化一次”指一个 admitted context lifecycle 中只发现、比较并建立一次 catalog。无状态 provider 后续请求仍需要序列化当前 baseline 和 history；这是传输层重放，不是重新扫描、重新选择或新增 model-visible context event。

Agent switch 会从已加载的 registry snapshot 重新应用 permission filter，并作为一次 Agent context activation 接纳新 catalog；它不扫描 filesystem。普通 turn、tool continuation、compaction、transparent reconnect 和 retry 都不刷新 Skill。

### 进入 Session 时 reload

以下行为属于 Session activation：

- 创建并显示新 Session；
- resume 已有 Session；
- 从另一个 Session 或 QuickStart 切回；
- 进程重启后首次打开 Session。

activation 调用 `skills.list(forceReload: true)` 等价的 Core workflow，清除相关 root scan cache并重新读取 metadata。TUI picker 使用同一返回快照，不能自行维护第二份发现结果。

Core 将新 catalog 与 Context Epoch 中的 `core/skill-guidance` snapshot 比较：

- digest 未变化：不写 Session event，不增加 model context；
- digest 变化：在当前 Context Generation 发布 typed hidden `ContextAdvanced`，cause 为 `skill-catalog-reloaded`，正文声明新 catalog supersede 旧 catalog；
- 临时读取失败：保留已接纳 catalog，显示诊断，不把所有 Skill 当作已删除；
- confirmed root removal 或 target policy change：新 snapshot 可以明确移除对应 Skill。

Skill reload 不修改 RFC-0011 的原始 baseline，不增加 Location `generation`，也不刷新 environment、AGENTS instructions、references 或其他 context source。它只推进 `core/skill-guidance` 的 source snapshot。Context advance 必须在下一条 prompt admission 前 durable commit；正在运行的 turn 不被中途改变。

unresolved/read-only Session 可以刷新 TUI 的 device-local preview catalog，但不能写 ContextAdvanced。Location 恢复并准备提交下一条 prompt 时再执行正常 activation admission。

## Transcript 与模型可见内容

用户时间线只渲染真实 `Prompt.text` 与 `$skill` mention token。每个 invocation 额外显示一行默认折叠的 typed context item：

```text
Skill · imagegen                                      ● loaded
```

focused 后 Enter 展开 invocation snapshot 的准确正文；关闭后恢复原 selection 与 scroll anchor。展开只读取 Session projection，不重新访问 controller file。长正文使用现有 tool-detail/scroll pattern，不改变整条 user message 的高度预算。

implicit `skill` tool 与 slash compatibility 使用同一 renderer。pending、failed、stale 与 loaded 使用共享状态词和符号；错误详情只在 focused detail 中显示。普通复制、fork prompt、edit prompt 与 timeline title generation 不把隐藏正文当作用户输入。

raw Session/API export 必须保留 structured invocation snapshot 以支持恢复；面向用户的 rendered transcript 默认保持折叠。正文不是安全 redaction：用户显式展开、原始导出或已授权调试接口仍可查看。

compaction 必须保留仍适用 Skill invocation 的语义和 digest。它可以把旧 invocation 纳入 checkpoint，但不能在 compaction 时重新读取本地 Skill，也不能把隐藏正文误标为新的用户请求。

## Controller-side Skill resource access

controller-owned Skill 的正文可以直接进入远程 Session，但正文引用的 `scripts/`、`references/` 或 templates 不存在于 Rexd filesystem。为避免暴露任意控制机文件工具，新增一个窄接口 `skill_resource`：

```text
skill_resource {
  skill: SkillID | InvocationID
  resource?: RelativePath
  cursor?: string
}
```

- 省略 `resource` 时返回有界、排序稳定的 relative file manifest；
- 指定 resource 时分页返回一个 UTF-8 text file；
- response 包含 resource identity、content、digest 与 next cursor，不返回 controller absolute path；
- binary 或超出支持限制的资源只返回 metadata 与 unsupported diagnostic，不自动编码进 context；
- read result 是普通 durable tool result，按 Session 规则同步并默认折叠显示。

每次调用重新验证 Skill 当前对 Session target 和 Agent 可用，并要求既有 `skill` permission。path 必须是 Skill root 内的规范相对路径；拒绝 absolute path、空段、`.`、`..`、编码后 traversal、symlink escape、special file 和 root 外 hardlink/realpath 结果。manifest 不跟随越界 symlink，也不递归无界扫描。

该 tool 使用 `ControllerFileSystem`，属于 RFC-0002 所允许的纯控制面 read capability。它不是 Session Location filesystem：

- 不返回可传给 target bash/read 的伪路径；
- 不执行 controller process；
- 不自动上传、mount 或复制文件到 target；
- Agent 若要在 target 使用脚本内容，必须通过现有 Location-scoped tools 执行显式、可审计的 target mutation，并遵守 permission。

当前设备创建的 invocation 可以直接关联 local `SkillID`；同步到另一设备后，resolver 改用 invocation snapshot 的 name 与 digest 匹配本地 catalog。没有唯一完全匹配项时，新的 resource read 返回 `resource_unavailable_on_device`；已经进入 Session 的 invocation snapshot 和历史 resource result 仍可继续读取。

## Schema、API 与实现边界

### Public contracts

Schema 增加或扩展：

- `Skill.ID`；
- `Skill.Metadata` 与 local-only source detail；
- `Skill.TargetScope`；
- `SkillSync.PackageKey`、manifest、version、operation、conflict、resolution 与 tombstone；
- `Prompt.SkillMention`；
- `Session.SkillInvocationID`；
- `Session.SkillInvocationSnapshot`；
- stale catalog、ambiguous name、resource unavailable、registry revision conflict 与 Skill sync errors。

Server Skill API 至少提供：

- 按 target/Agent 返回 resolved catalog，可请求 `forceReload`；
- 查询 discovery roots、diagnostics、target scopes 与 registry revision；
- revision-protected add/remove/reset root；
- revision-protected update target scope。

catalog API 默认不返回完整 body。source absolute path 只允许出现在 authenticated device-local settings response，不进入 prompt、Session event、sync payload 或 model context。

Sync API 在 RFC-0010 现有 settings/status/run contract 中增加 device-local `skillsEnabled`、package summary、conflict list 与 resolution mutation。它不增加第二个 provider credential 或 worker endpoint。cloud manifest/version negotiation 必须使不理解 Skill payload 的旧客户端忽略 Skill namespace，而不能删除、ack 或错误投影它。

Prompt API 接受 structured Skill mention。公共 Protocol 或 Server `HttpApi` 变化后，必须从 `packages/client` 运行 `bun run generate`；不得直接编辑 generated clients。

### Ownership

- controller-global Skill Registry 负责 roots、filesystem discovery、SkillID、cache、diagnostics 与 target policy；
- Skill Sync domain 负责 eligible-root inventory、package manifest、outbox、cloud projection、conflict、tombstone 与 atomic local materialization；
- Location-scoped model context assembler 消费 registry snapshot并应用当前 target/Agent filter，但不扫描 target filesystem；
- Session admission 负责 mention resolution 与 durable invocation snapshot；
- Session Context Epoch 负责 activation-scoped catalog baseline/advance；
- Tool registry 提供 implicit `skill` 与 controller-side `skill_resource`，两者共享 canonical resolver；
- TUI 只渲染 typed state、维护 composer extmark 并 dispatch registry/session actions；
- sync adapter 传输正式 Session events 与 Skill Sync operations；它不能上传 registry 配置、非 eligible root 或当前 filesystem 的临时扫描结果。

legacy Skill discovery、slash registration 与 Core V2 实现必须收敛到一个 canonical service。兼容层可以转换旧 API shape，但不得保留另一份 cache、precedence 或 body rendering 语义。

## 失败行为

- 一个 root 发现失败不会阻止其余 root；已接纳 Session catalog 不因临时 I/O failure 被清空。
- 初次 Session 初始化若 registry 整体不可用，Skill guidance 可以带诊断建立为空；它不能阻止基本 Agent 使用，除非用户显式 mention 的 Skill 无法验证。
- explicit mention 在 admission 前读取失败或 digest stale 时，整条 prompt 不接纳；用户文本与 draft 保留。
- implicit load 失败形成正常 failed tool result，不伪造 loaded snapshot。
- manager mutation conflict、permission failure 或 invalid path 不改变已有配置和当前 selection。
- Session activation reload failure 不修改 Context Epoch；下一次重新进入可以重试，同一活跃会话不后台轮询。
- target scope 中出现 missing target 只产生设置诊断，不影响其他明确 target。
- resource read 失败不得回退 Location filesystem、Shell、网络 URL 或同名 Skill。
- Skill sync 关闭、旧客户端或未 opt in 设备不 inventory、下载或 ack Skill objects；Session sync 继续独立工作。
- package scan、staging download、digest verification 或 atomic rename 失败时保留 last admitted local package 与 pending operation，不留下可发现的半包。
- remote delete 与本地修改并发时形成 conflict，不删除本地内容；一次 missing/list/stat 结果不能产生 tombstone。
- cloud/provider failure 沿用 RFC-0010 bounded retry、leader fencing 与脱敏状态，不能阻止本地 Skill 使用。
- 日志记录 SkillID、阶段、stable error kind 与 digest 摘要；不得记录 Skill body、resource content、controller absolute private path 或 credential。

## 兼容与迁移

1. OpenCode user/project native roots 继续可用，但 `.claude` 与 `.agents` 不再隐式加入；需要它们的用户通过 manager 显式 import。
2. 已有 `skills.paths` 与 `skills.urls` 保持有效，并显示为 imported source。没有 target override 时默认为 all targets。
3. 当前按 name 覆盖重复 Skill 的行为迁移为同时保留多个 `SkillID`；唯一 name 的用户行为不变，重名调用从静默覆盖变为显式选择。
4. `/<skill>` 在兼容期继续工作，但不再作为 template 展开；普通 custom command 不受影响。
5. 已有 Session 中作为普通 user text 保存的历史 Skill 展开不重写。新的调用使用 structured snapshot；旧消息首次 resume 不尝试反向猜测 Skill identity。
6. 没有 `core/skill-guidance` snapshot 的旧 Session 在首次可写 activation 时建立一次 catalog advance；不重写 RFC-0011 baseline。
7. 现有 Skill permission 继续生效。target scope 是额外 availability filter，不替代 allow/ask/deny。
8. Skill Registry、discovery/target 配置与非 eligible package 始终排除在 RFC-0010 sync 外；invocation snapshot 和已读取 resource result 跟随 Session。
9. 用户显式开启 Skill sync 后，OpenCode global roots 的 eligible package 通过独立 Skill namespace 同步，不混入 Session payload。
10. 既有 Session sync 用户升级后 `OpenCode Skills` 为关闭，不发生静默 backfill。开启时才扫描并排队现有 OpenCode global package。
11. 不支持 Skill payload 的旧客户端继续同步 Session，但不下载、不确认、不删除 Skill objects；新客户端不能把旧客户端视为已 ack Skill tombstone。
12. v1 只实现 TUI manager、composer 与 sync controls；Web/Desktop 可以通过公共 API 显示已有 invocation，但不提供部分可编辑设置 UI。

## 验收条件

1. 默认安装只发现 OpenCode-owned roots；Codex、Claude、`.agents` 和自定义 roots 不会隐式出现。
2. Add、Codex preset、Claude preset、remove 与 reset 均通过同一 registry workflow；reset 后只剩 defaults，且不删除任何 Skill 文件或 cache。
3. existing `skills.paths/urls` 升级后仍可用；registry mutation 使用 revision/CAS 并保留 JSONC 未修改字段。
4. `$` picker 使用当前 admitted target/Agent catalog；选择、删除、draft/history restore、paste、external editor 与 submit 的 extmark/part 一致。
5. Shell variable、escaped dollar、code text、unknown name 与 ambiguous name 不会误调用 Skill。
6. `$skill request`、`/<skill> request` 和 implicit `skill` tool 都保留原始用户请求；Skill 中 literal `$ARGUMENTS` 与 `$1` 不被替换。
7. 同一 prompt 的多 Skill 顺序稳定且去重；重名 Skill 通过 SkillID 精确选择。
8. 新 Session 初始化只接纳一次 catalog；普通 turn、retry、tool continuation 与 compaction 不扫描 Skill roots 或创建重复 context event。
9. 活跃 Session 新增 Skill 后保持冻结；退出并重新进入后，TUI picker 与下一次 model request 都能发现它。
10. unchanged activation 不写 event；changed activation 只推进 `core/skill-guidance`，不重写 system baseline、不增加 Location generation、不刷新其他 context source。
11. local、all targets、具体 Rexd target、空名单、renamed target、missing target 与 restored same-ID target 的 availability 都符合本 RFC。
12. model request 收到完整 invocation snapshot，TUI 默认只显示 `$name` 与折叠行；展开显示准确 snapshot 而不重新读盘。
13. copy、fork、edit、timeline title 与 rendered export 不把 Skill body 当作用户输入；raw export、replay 与 compaction 保留结构化内容。
14. Session sync payload 包含已调用正文与已读取 resource result，不包含 controller root、target scope、registry config 或 package inventory；独立 Skill namespace 只包含 opt-in eligible package。没有本地 Skill 的另一设备仍可继续已有 invocation snapshot。
15. `skill_resource` 可以从 local 与 Rexd Session 读取 controller-owned text resource，并拒绝 absolute path、traversal、symlink escape、binary 与越界请求。
16. Rexd Agent 不能通过 Skill resource 获得 controller Shell/process authority，也不能把 controller path 传给 Location tools 后静默回退本地。
17. `OpenCode Skills` 在新装和升级设备均默认关闭；未 opt in 时没有 Skill inventory、upload、download 或 acknowledgement，Session sync 不受影响。
18. 开启后只同步 global `skill/`、`skills/` 下的完整 package；project、Codex、Claude、`.agents`、custom、URL cache、built-in、symlink 与内部 state 均不进入 payload。
19. package manifest 保持原子，nested Skill ownership、大小写 collision、稳定 scan、size limit、content digest、staging 与 crash recovery 有 contract/integration test。
20. 两设备顺序编辑自动 fast-forward；相同 digest 幂等；并发编辑、并发 delete/update 与 Keep current/Use incoming/Keep both resolution 不静默丢失内容且最终收敛。
21. Skill tombstone 在 offline old head、pending old update、重启和 GC 后不复活；remote delete 先进入 managed trash，任何清理都不越出该目录。
22. Skill sync 成功 materialize 后 registry cache 失效；活跃 Session catalog 保持冻结，退出重进后发现同步到的新 Skill 或版本。
23. cloud reset 的确认与清理同时覆盖 Session 和 Skill namespaces，本地 Skill 保留；logout、disable 与旧客户端兼容不删除本地 package。
24. registry、admission、Context Epoch、sync 与 TUI failure states 有 unit/contract/integration coverage；公共 API generation 与 package-local typecheck 通过。
25. Mac 与 `mywindows` 使用同一提交构建的 `opencode-transit` 完成 local 与 Rexd 的 import、target filter、`$` mention、re-enter reload、fold/expand、resource read、OpenCode Skill 双向同步、并发冲突、删除防复活和跨设备 resume 实测，并附 TUI 截图或录屏。

## 参考

- [OpenAI Codex Skills documentation](https://learn.chatgpt.com/docs/build-skills)
- [OpenAI Codex App Server skills API](https://learn.chatgpt.com/docs/app-server)
- [OpenCode #33980: Collapse skill body in user message](https://github.com/anomalyco/opencode/issues/33980)
- [OpenCode #40463: slash-invoked skills replace user prompt](https://github.com/anomalyco/opencode/issues/40463)
- [OpenCode #48189: native skill tool exposes full SKILL.md in transcript](https://github.com/anomalyco/opencode/issues/48189)
