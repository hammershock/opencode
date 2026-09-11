---
id: 0003
title: Core Command Toolkit and Upstream Compatibility
status: accepted
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-11
implemented-by:
  - https://github.com/hammershock/opencode-transit/pull/86
depends-on:
  - 0001
supersedes: []
superseded-by: []
---

# RFC-0003：Core Command 工具集与上游兼容

## 摘要

为本仓库的核心功能开发提供一套规范化 command toolkit，使维护者和下游 fork 可以实现可发现、可组合、可测试的 slash command，而无需修改 prompt、autocomplete 或 command palette 等通用 UI 组件。工具集统一命令身份、分层路径、参数解析、来源、发现、冲突、配置、权限声明、执行上下文、生命周期和结果契约，但不要求 UI action、Core operation、Agent prompt 和复合 workflow 使用同一种底层 handler。

工具集主要服务于本仓库新增的 Core 功能及希望复用它的下游 fork，不要求外部插件、MCP、Skill 或普通 custom command 采用新接口。新框架必须兼容对应上游 OpenCode 版本中已有的命令来源和公开插件接口；未经显式迁移的外部命令保持上游行为，不因本 fork 的内部规范化而改变是否写入 Session、是否进入模型上下文或是否调用 Agent。

对于未来 upstream 版本，本 RFC 采用隔离适配、能力探测和兼容测试降低升级成本。它不对尚未发布、无法预知的未来 API 承诺绝对兼容；每次同步 upstream 时必须重新验证兼容矩阵。

## 定位与使用者

Command toolkit 的直接使用者是：

- 本仓库中实现 Rexd、Location environment、同步等 Core 功能的开发者；
- 后续维护本 fork 的 Agent 和人类贡献者；
- 希望在自己的 fork 中增加一等 Core command、但不希望侵入通用 UI 的下游维护者。

外部插件作者仍以对应 upstream 发布的 plugin API 为默认契约。toolkit v1 不发布新的插件接口；未来版本只有经过版本化并允许 feature detection 后，才可以向主动采用的插件开放扩展能力。

工具集至少应提供：

- command definition 与 registry；
- 单段和分层 command path 的统一解析；
- 参数 schema、帮助和补全接入点；
- provenance、shadowing 和冲突诊断；
- client invocation context 与类型化 domain service 调用约定；
- confirmation、capability、取消、失败和 outcome 基础设施；
- Core services 调用约定；
- 上游来源 adapter；
- 面向 Core command 和下游 fork 的测试 harness。

## 已确认的 Core 消费者

以下 command family 必须使用本 toolkit 注册和实现，不得各自在输入组件中增加解析分支：

| Command family         | 基础职责                   | 业务规格归属     |
| ---------------------- | -------------------------- | ---------------- |
| `/target`              | 打开和管理设备 target registry | RFC-0002      |
| `/env`                 | 管理 location environment  | RFC-0005         |
| `/sync`、`/devices`    | 管理跨设备同步和设备       | RFC-0010         |
| `/permissions`         | 查看或切换权限交互策略     | RFC-0006         |
| `/expand`、`/collapse` | 展开或收起截断的命令输出   | RFC-0006         |
| `/delete`              | 确认并删除当前 Session     | RFC-0006         |

这些都是本仓库提供的基础 Core 能力。列入本表只确认其身份、基础职责和 toolkit 接入要求，不代表接受旧归档中的具体实现，也不替代各功能 RFC 对状态、权限、持久化、同步和失败语义的定义。

RFC-0006 中经确认的 upstream built-in command override 也必须使用 toolkit，但它们保留 upstream identity，不归类为本仓库新增的 Core command。

各功能 RFC 负责定义自己的业务流程、权限、失败和验收语义；RFC-0003 只提供共同基础设施和维护约束。其他新 Core command 默认也应使用 toolkit，除非其 RFC 明确说明无法使用的技术原因。

对应 upstream 版本原生支持的 slash command 与外部生态命令先通过 adapter 保持原实现和行为，不要求为了形式统一而立即重写。以后如果迁移某个上游原生命令到完整 toolkit API，必须有行为等价测试，并保持公开接口与插件观察到的生命周期不变。

## 必须满足的约束

1. 旧归档中把 `/env`、`/target`、`/cd`、`/sync`、`/permissions`、`/delete` 等命令直接写入 prompt 提交函数的方式不得复用。
2. 本仓库新增的 Core command 必须通过 toolkit 的统一 registry 注册，不允许修改通用输入组件来识别某个具体命令。
3. 一个命令可以编排多个有条件的步骤，不能被压缩成单一 `kind` 或几项可任意组合的布尔属性。
4. 对应上游版本支持的所有外部命令来源、调用入口、公开类型和默认冲突语义必须保持兼容。
5. Fork 扩展采用增量、可探测、可版本化的 API；外部插件不采用扩展时继续走兼容适配器。
6. 模型调用、Session 写入和上下文投影由 workflow 实际调用的受控服务决定，不能由用户在配置中任意改写。
7. 框架必须显示并保留命令 provenance，不能把外部内容伪装成 Core 内建命令。
8. toolkit 的可复用部分不能依赖某个具体 fork feature；Rexd、environment 和 sync 只能作为消费者。

## 动机

OpenCode 当前把多种机制都呈现为 `/name`：

- TUI/Web/Desktop 的客户端 command，通常直接执行 UI callback；
- `/init` 和配置文件中的 custom command，展开模板后调用 Agent；
- MCP prompts；
- 可作为 slash command 使用的 Skills；
- TUI 插件通过公开 API 注册的 command；
- 插件对 command 或执行前 parts 的 transform/hook。

它们共享输入语法，但不是同一种执行机制，也不具有相同信任边界。toolkit 的目的不是接管或抹平所有外部实现，而是为 Core 开发提供稳定积木，并用 adapter 将既有来源投影到统一的发现和冲突管理平面。

旧归档中的 `/env init` 进一步说明命令可能是复合 workflow：

```text
解析 Location
  -> .env 不存在时创建模板
  -> 构造并提交 Agent prompt
  -> 等待 Agent 完成
  -> 成功后 reload environment
```

其中只有 Agent prompt 步骤进入 Session 和模型上下文。把 `entersSession`、`entersContext` 或 `invokesModel` 作为整个命令的可编辑属性，会错误描述这种流程。

## 设计原则

### 1. Core-first toolkit，不强制统一执行位置

toolkit 分成两层：

- definition plane：统一描述身份、路径、参数、来源、展示、兼容模式、声明能力和 host 要求；
- execution plane：由受信任的 client handler 调用类型化 Core/domain services 编排实际 workflow。

客户端 UI action 可以保留客户端 handler；涉及 Location、Session 或持久状态的 operation 应进入共享 Core/Server service；Agent prompt 通过 Session prompt service 提交。统一 registry 不意味着把这些代码塞进同一进程或同一种回调。

本仓库和下游 fork 的新 Core command 使用完整 definition/execution API。外部来源只需提供其 upstream 契约已有的信息，由 adapter 生成兼容视图；adapter 不得假装外部命令拥有它没有声明的精细能力。

### 2. 效果属于步骤，不属于命令标签

框架不提供以下可自由组合的命令级开关：

```text
entersSession
entersContext
invokesModel
```

handler 通过受控服务产生效果：

- 调用 Session prompt service 时，由该服务创建可回放的 Session parts、构造模型上下文并调用 Agent；
- 调用 environment、target、sync 等 domain service 时，由对应服务执行查询或变更；
- 调用 UI service 时，只影响当前客户端；
- 如果 operation 需要审计记录，应写入对应 domain event，不能伪装成用户 prompt。

声明的 capabilities 表示 workflow 可能使用的权限上界，服务调用才是实际发生的效果。capability 用于发现、确认和授权，不是 workflow DSL。

### 3. 复合 workflow 使用普通代码编排

第一阶段不设计声明式 workflow 语言。Core 内建命令使用普通 TypeScript handler，并通过窄接口访问服务：

```ts
defineCommand({
  id: "core.environment.init",
  path: ["env", "init"],
  capabilities: ["workspace.write", "agent.invoke", "environment.reload"],
  execute: (context, input) => environmentInitWorkflow(context, input),
})
```

以上是目标接口示意，不是现有 OpenCode API，也不要求最终实现采用相同命名。业务 workflow 必须位于可单独测试的 feature/domain 模块；command handler 只负责解析、确认、调用和呈现结果。

### 4. 属性附着于可执行叶子命令

命令使用 token path 表达层级，并采用 longest-match 解析：

```text
/env             # group/help 或独立叶子
/env status      # 独立叶子
/env reload      # 独立叶子
/env init        # 独立叶子
```

能力、handler 和兼容策略属于 `/env init` 等叶子，而不是笼统属于 `/env` group。上游单段命令作为长度为一的 path 适配，不改变其输入形式。

## Toolkit v1 接受方案

### v1 边界

v1 只解决本仓库新增 Core command 和经 RFC-0006 接受的 upstream override，不替换 upstream 已有的 prompt-command catalog、TUI keymap、Web CommandProvider、`session.command` 或插件 API。

v1 不建立可从网络调用任意 Core handler 的通用 `command.execute` endpoint。所有 toolkit handler 都在发起交互的 client host 内执行；涉及 Session、Location、Agent 或持久状态的业务操作必须调用已有或功能 RFC 新增的类型化 domain service/API。这样可以保持授权、返回 Schema 和重试语义属于业务域，而不是退化成一个返回 `unknown` 的万能命令 RPC。

这里的“从网络执行 command”特指让客户端通过 command 名称和不透明参数调用任意 Server handler，例如：

```text
POST /command.execute { command: "env init", args: "..." }
```

它不限制 Rexd Location 上的远程 Shell/process，也不禁止 command 调用 Server。正确边界是 command handler 调用用途明确、输入输出类型化的 domain API：`/delete` 调用 Session delete，`/env reload` 调用 Environment reload，`/sync now` 调用 Sync service。Rexd process 仍通过 RFC-0002 的 Location process contract 执行，与 command toolkit 的网络边界无关。

不提供万能 endpoint 的理由是：

- UI-only command（例如 `/expand` 或打开 dialog）没有合理的 Server 执行语义；
- 将任意 Core workflow 暴露为字符串 RPC 会扩大权限面，使授权、幂等、错误和副作用只能依赖运行时 metadata；
- 不透明参数和 outcome 无法形成可靠的 generated SDK contract；
- 各业务 domain 已经需要自己的 schema、权限、事件和重试规则，万能 endpoint 只会形成第二条绕过路径。

因此 v1 的统一对象是 command 的定义、解析、发现和客户端 dispatch，而不是把所有 handler 远程化。如果未来确实需要 server-owned discovery、自动化或无客户端调用，必须设计可 feature-detect、输入输出类型化且版本化的 command protocol，不能直接公开内部 registry。

例如：

- `/expand` handler 可以直接改变当前客户端的显示状态；
- `/env reload` handler 调用 environment API，不能自己读取文件；
- `/env init` handler 调用 environment workflow API，该 workflow 可以创建模板、提交 Agent prompt 并 reload；
- `/delete` handler 负责获取确认并调用 Session delete API，同步模块通过 domain event 观察删除。

如果未来需要无客户端的远程命令执行、自动化 API 或 server-owned command discovery，必须新增版本化协议并另行评审，不属于 toolkit v1。

### 代码归属

v1 新建私有 workspace package `@opencode-ai/command-kit`，建议目录为 `packages/command-kit`。它只能依赖通用 TypeScript/runtime primitives，不依赖 Solid、OpenTUI、Server、SDK 或具体 feature。

该 package 提供：

- `defineCommand()` 类型辅助；
- registry、longest-match resolver 和冲突诊断；
- raw argument boundary 解析；
- completion 与 replacement range 类型；
- invocation context 和 outcome 基础类型；
- 可脱离 UI 运行的 conformance test harness。

适配层分别位于所属客户端：

```text
packages/command-kit                 shared definition + resolver
packages/tui/src/command-toolkit    OpenTUI keymap adapter
packages/app/src/command-toolkit    Web/Desktop CommandProvider adapter
packages/opencode                   typed domain services and legacy compatibility path
```

Core command definition 放在对应的 client-safe feature contract 模块附近，再由客户端 composition root 注册；不建立一个知道所有业务模块的中央巨型文件。不同客户端共享 metadata 时，该模块不能依赖 Server 或具体 UI。业务 workflow 不放进 `packages/command-kit`。

现有 `packages/core/src/command.ts` / `CommandV2` 继续表示 prompt template command catalog。v1 不扩写它来承载 UI action 或 Core operation，避免改变 V2 plugin transform 和 `/api/command` 的既有语义。

### v1 definition contract

下面的接口是 v1 必须表达的语义；实现时允许按仓库风格调整具体 TypeScript 拼写，但不得增加新的架构职责：

```ts
type CommandDefinition<Input, Context> = {
  id: string
  path: readonly string[]
  aliases?: readonly (readonly string[])[]
  title: string
  description?: string
  category?: string
  provenance: { type: "core"; feature: string }
  requires?: { session?: boolean; location?: boolean }
  readOnly?: boolean
  capabilities: readonly string[]
  parse: (input: RawArguments) => ParseResult<Input>
  complete?: (input: CompletionInput, context: Context) => Promise<readonly CompletionItem[]>
  available?: (context: Context) => boolean
  execute: (context: Context, input: Input) => Promise<CommandOutcome>
}
```

稳定语义：

- `id` 使用不含开发者名称的反向域式身份，例如 `core.environment.reload`；
- `path` 和 alias 是不含 `/` 的 token 数组；token 使用小写 ASCII 字母、数字和 `-`；
- group 只是具有共同 path prefix 的展示结果，不是可执行对象；如果 `/env` 本身可执行，它必须注册为独立叶子；
- `parse` 属于叶子命令并返回类型化 input，不提供全局 flags DSL；
- `available` 只表达客户端状态可用性，不代替权限检查；
- `readOnly: true` 是 command 对只读 Session 安全性的显式声明：该 command 不得接纳 prompt、进入 Agent/model context、调用模型、执行 Shell/tool、访问不可用 Location，或持久化 Session、配置、target、workspace 等状态；纯展示、只读查询、恢复入口导航和退出流程可以声明为 `true`。未声明或不能证明满足这些约束时按 `false` 处理；
- `capabilities` 是静态上界和审查信息，v1 不把它实现成新的安全沙箱；
- `execute` 只能通过 context 中暴露的窄服务执行，并返回统一 outcome。

`readOnly` 只用于阻止只读 Session 中的 command dispatch，不能代替受控 service 边界。Core command 必须显式声明；upstream/client adapter 可以投影可信的 host metadata。现有 plugin、custom command、MCP prompt 和 Skill 接口不增加必填字段，未采用扩展的外部来源保持可注册、可发现，并在只读 Session 中默认拒绝执行。

### 输入解析

v1 采用以下固定算法：

1. 只有首字符为 `/` 的输入参与 slash 解析；不忽略前导空格，也不预先删除后续换行。
2. command path 只从第一行按 ASCII whitespace 切分 token。
3. registry 在 path 和 aliases 中进行 longest-match。
4. 匹配完成后，将原输入中未消费的部分作为 `RawArguments`，保留内部空格、Unicode 和后续行；只移除 path 后作为分隔符的一段空白。
5. 叶子的 `parse` 决定引号、flags、枚举、路径或多行内容的具体语义。
6. 未匹配时 resolver 返回 `not-found`，不得在底层伪造命令；TUI host 对首字符为 `/` 的未匹配输入显示 `Slash command does not exist` 并终止提交，不得创建 Session message、写入 prompt history 或进入模型上下文。非顶格 `/` 的普通文本保持 prompt 语义。

这允许 `/env init` 与 `/env reload` 共存，也允许 `/rename <title>` 保留完整标题，而不要求 toolkit 实现一门 Shell 参数语言。

### Invocation 与 outcome

Invocation context 至少提供：

```text
source = slash | palette | keybind
client = tui | web | desktop | cli
sessionID?
location?
abortSignal
confirm(request)
```

客户端 adapter 可以增加自己的窄 UI service，但 command definition 不得直接获取整个应用 store 或任意 service locator。

统一 outcome 固定为：

```text
completed | cancelled | failed | unknown
```

- `failed` 必须包含稳定 error code、可展示消息和 `retryable`；
- `unknown` 只用于无法判断远端副作用是否已经发生的情况；
- toolkit 不自动重试有副作用的 handler；
- outcome 可以携带安全的用户提示，但不作为无类型业务数据传输通道；
- 查询结果和 domain object 继续使用对应 feature 的类型化 API。

### Host adapter 与 dispatch 顺序

每个客户端只允许有一个 toolkit integration point，负责 autocomplete、palette、keybind 和 submit dispatch。具体业务命令不得再修改这些通用组件。

为完整保持 upstream 兼容，raw slash dispatch 顺序固定为：

```text
upstream host resolver
  -> 构建期已验证的 accepted upstream override decorator
  -> fork Core registry longest-match
  -> unresolved leading slash rejection
  -> normal prompt submission for non-slash input
```

因此，按照当前 upstream 规则已经生效的用户 command、MCP、Skill 或插件 command 继续优先，不会因为 fork 新增同名 Core path 而改变行为。如果它遮蔽了 fork Core command，诊断接口必须同时显示 winner 和 shadowed candidate。

Core registry 内：

- duplicate `id` 注册失败；
- 不同 Core identity 注册相同 path 或 alias 也注册失败；
- alias 与其他 Core canonical path 发生冲突同样失败；
- 失败必须在开发和测试中可见，不能依赖注册顺序选 winner。

### Upstream override decorator

RFC-0006 的 override 不是注册一个抢占同名 path 的新命令，而是显式装饰在构建期验证过的 upstream identity：

```ts
defineOverride({
  id: "fork.session.exit-to-home",
  target: verifiedUpstream.tui.appExit,
  experimentalSetting: "commands.exitToHome",
  decorate: (next) => async (context, input) => {
    if (context.sessionID) return context.navigation.home()
    return next(context, input)
  },
})
```

`verifiedUpstream` 是仓库构建步骤从固定 upstream baseline 的 command catalog、稳定 metadata 和 contract fixture 生成的类型化 manifest。override 源码只能引用 manifest 中的导出，不能手写 host/id 字符串或在运行时按 slash 名称查找目标。

静态 verifier 是 typecheck/build/CI 的强制前置步骤，必须检查：

- 目标 identity、host、path、aliases、availability contract 和 handler input boundary 仍与 baseline 一致；
- contract fingerprint 与已审查 fixture 一致；
- 一个 upstream identity 没有被多个互斥 decorator 意外绑定；
- manifest 与当前源码注册 catalog 同步，没有陈旧或无法解析的目标。

目标缺失、metadata/contract 漂移或 manifest 陈旧时，构建直接失败，要求更新 baseline、fixture 和 RFC 审查；不能把已知不兼容的 override 当作正常产物发布。生产运行时不重新判断 fingerprint/drift，只处理 route、Session、experimental setting 和注册生命周期等正常 availability。外部来源的优先级仍由 upstream host resolver 决定。

所有 upstream override 都是实验性功能，并且必须具有设备本地、用户级、默认关闭的独立 setting。setting 关闭时不尝试安装 decorator，完整使用 upstream handler。setting 开启后，如果 decorator 因当前客户端生命周期、依赖不可用、注册冲突或其他运行时条件而无法安装或应用，resolver 必须保留原 upstream candidate，并发出包含 override identity、upstream identity 和失败原因的结构化 warning；不能让应用启动、命令解析或原命令执行失败，也不能留下半安装状态。warning 可以进入日志和实验功能面板的诊断状态，但不得写入 Session 或模型上下文。

这里的运行时 fallback 不替代静态 verifier：静态检查负责阻止“源码已经与固定 upstream contract 不兼容”的构建；fallback 负责已通过构建的产物在具体设备和客户端中的温和退化。二者不得使用 silent catch 掩盖测试或 baseline drift。

### v1 capability 与配置边界

capability 名称采用命名空间字符串，例如 `workspace.write`、`agent.invoke`、`environment.reload`。v1 用它完成代码审查、帮助展示、确认策略和测试断言；真正的权限仍由被调用的 domain service 与现有 permission system 执行。

v1 只允许对 Core command 配置：

- enable/disable；
- hidden/visible；
- alias、keybind 和展示 category；
- 增加确认要求；
- 按 capability 拒绝整个 command。

v1 不允许配置者改写 handler、删除 handler 内的步骤或扩大 capability。对外部命令的可配置范围继续保持 upstream 行为，不在 v1 引入新的通用编辑器。

## 来源与信任边界

建议使用下列 provenance，而不是只有一个 `trusted` 布尔值：

```text
core
user-config
project-config
mcp(serverID)
skill(location)
plugin(pluginID, version)
legacy-plugin(pluginID, version)
```

### Core 命令

本仓库实现并经过代码审查，允许注册 UI、Core operation、Agent prompt 和复合 workflow。仍必须遵守权限、Session 和 secret handling 规则。

### 配置、MCP prompt 与 Skill

这些来源提供 prompt 内容，不获得任意 Core handler 权限。其内容可能不可信，但 Agent 后续工具调用仍经过正常权限系统。UI 应显示来源。

### 外部插件

外部插件在安装和启用前不受信任；当前 OpenCode 插件不是安全沙箱，启用后其代码实际上拥有插件 API 及宿主进程允许的能力。因此：

- 必须由用户显式安装和启用；
- 命令显示插件来源；
- command framework 不授予插件超出原公开 API 的额外权限；
- 外部插件不能仅靠 command metadata 绕过工具或 Core operation 权限；
- 对真正不可信插件的沙箱和 capability isolation 需要单独 RFC。

Slash command 本身不是新的信任边界；它只暴露已经被加载的来源所拥有的行为。

## 上游兼容边界

兼容分为两个目标：

- 向后兼容：为当前所跟随 upstream 版本已经支持的插件、配置、MCP、Skill 和客户端保留行为；
- 上游演进兼容：把 fork 扩展限制在 toolkit 和 adapter 内，通过 feature detection、版本范围及 conformance tests 降低后续同步成本。

“上游演进兼容”不意味着自动理解未来新增的任意 API。未知来源或字段应尽可能由原 upstream 路径透传；如果无法安全透传，必须明确报告不支持，不能猜测语义。

### 兼容来源

至少为以下来源提供 adapter：

1. 上游内建客户端 command；
2. JSON/JSONC `command` 配置；
3. `.opencode/commands/*.md` 及上游支持的 command 目录；
4. MCP prompt；
5. Skill slash command；
6. legacy TUI `api.command.register`；
7. V2 keymap/TUI command registration；
8. legacy `command.execute.before` hook；
9. V2 command transform。

### 行为保持

兼容 adapter 必须遵守：

- prompt template、参数替换、`agent`、`model`、`subtask` 和 lazy MCP resolution 保持原义；
- legacy UI callback 仍在原 placement 执行；
- plugin hook 的调用时机和可修改数据保持原义；
- 上游允许的同名 custom command 覆盖规则继续生效；
- 现有 `command.list`、`session.command` 和 TUI plugin API 不增加必填字段；
- 旧客户端看不到新能力时仍能使用它原本支持的命令；
- adapter 不根据猜测改变命令是否调用模型或写入 Session。

无法可靠声明 capabilities 的 legacy plugin command 标记为 `legacy-opaque`。它保持上游执行行为，并在 UI 中显示来源；不能伪造一份不完整的精细权限声明。

### 公共 API 演进

新能力不得通过破坏性修改现有 generated SDK 类型实现。优先顺序是：

1. 内部 registry 和 adapter；
2. 新增可选字段且旧客户端会安全忽略时，扩展现有 Schema；
3. 否则新增版本化 endpoint/capability negotiation；
4. 经过弃用周期后才能移除 legacy adapter。

Fork-aware 插件或下游 fork 可以 feature-detect 新 command API；普通上游插件不需要识别本 fork。

## 用户可配置边界

以下是 toolkit 的长期安全边界；其中 Core command 的 v1 范围以上文“v1 capability 与配置边界”为准，外部来源在 v1 继续使用 upstream 已有配置能力。

用户可以对任意来源的命令配置表现和更严格的限制：

- enable/disable；
- hidden/visible；
- alias 和 keybind；
- 展示顺序或 category；
- 增加确认要求；
- 收紧允许的 capabilities。

用户可以编辑自己拥有的 prompt command 的 template、agent、model 和 subtask 配置。对于外部来源，默认不原地改写其 workflow 语义；需要改变时应创建本地 wrapper/replacement，并清楚显示 shadowing 关系。

`legacy-opaque` command 无法安全地做细粒度 capability 收紧，只允许 disable、隐藏或增加整体确认；如果用户策略拒绝其不透明能力，命令整体不可用。

用户不能通过覆盖配置：

- 让模型调用不留下必需的 Session 记录；
- 把任意 UI callback 输出自动注入模型上下文；
- 跳过 handler 或插件要求的确认；
- 扩大插件 capabilities；
- 把 prompt command 静默变成 Core operation，或反向转换；
- 绕过现有 permission system。

如果用户策略禁止 workflow 必需的 capability，命令应在产生部分副作用前报告不可用；不能只跳过中间步骤后继续执行一个语义残缺的流程。

## 冲突与覆盖

命令使用稳定 `id` 区分身份，使用 `path` 参与用户输入解析。registry 必须保留所有候选及 provenance，不能在加载时静默丢弃被覆盖定义。

兼容模式下，同名覆盖顺序与对应上游版本一致。新框架额外要求：

- 命令面板显示最终生效来源；
- 可以检查被 shadow 的定义；
- alias 冲突不能静默改变高风险 operation；
- 多段 path 使用 longest-match，避免 `/env` 抢占 `/env init`；
- 不使用开发者姓名作为 namespace；插件身份使用其稳定 package/plugin ID。

## 错误、取消与收尾

所有新式 handler 返回统一 outcome：

```text
completed | cancelled | failed | unknown
```

复合 workflow 必须定义：

- 哪些 preflight 在副作用前完成；
- 用户取消时是否已经发生修改；
- Agent 失败或被中断后是否运行 finalize；
- operation 是否可以安全重试；
- 结果未知时是否禁止自动重复；
- secret 是否可能进入错误或诊断信息。

以 `/env init` 为例，模板创建、Agent 编辑和 reload 的精确失败语义由 RFC-0005 决定；command framework 只提供可表达、可等待和可测试这些阶段的基础契约。

## Core 与下游 Fork 维护规范

本仓库或采用 toolkit 的下游 fork 新增、修改 slash command 时，PR 必须回答：

1. 稳定 `id`、用户 path、aliases 和 provenance 是什么？
2. 是叶子命令还是 group？参数如何解析和补全？
3. 哪些 client host 支持它，handler 调用哪个类型化 domain service/API？
4. 业务逻辑位于哪个可复用 domain/feature service？
5. 可能使用哪些 capabilities？哪些步骤有副作用？
6. 哪一步可能调用 Agent、写入 Session 或影响模型上下文？
7. 确认、权限、取消、失败、重试和收尾语义是什么？
8. TUI、Web/Desktop、CLI 和 SDK 中哪些入口支持它？
9. 是否改变上游公开接口或 legacy 行为？兼容测试在哪里？
10. 是否包含 secret-bearing 输入或输出？如何避免泄漏？

命令特有业务逻辑不得放入通用 autocomplete、prompt submit 或 command palette 组件。

## 实现阶段

### 阶段一：最小原型

- 建立私有 `packages/command-kit`，只实现 definition、registry、解析、completion contract、outcome 和诊断。
- 用纯单元测试覆盖 longest-match、alias、raw arguments、多行输入、duplicate rejection、取消和失败。
- 建立 synthetic upstream resolver fixture，验证 upstream-first、resolver not-found 和 shadowing 诊断；TUI host fixture 另行验证顶格未知 slash 被拒绝且非顶格 `/` 仍可 passthrough。
- 建立 synthetic override fixture 和静态 manifest verifier，验证 identity/fingerprint、实验开关、原子安装、运行时 warning fallback，以及 drift 导致 typecheck/build 失败。

原型不得先加入真实 `/env`、`/target` 或同步业务。它的目标是验证 toolkit contract，而不是借原型提交未接受的功能实现。

### 阶段二：TUI adapter 与第一个消费者

- 在 TUI 建立唯一 integration point，并复用现有 OpenTUI keymap。
- 首个真实消费者使用低风险、client-local 的 `/expand` 与 `/collapse` alias。
- 验证 slash、palette、keybind 使用同一 identity 和 handler。
- 验证关闭或移除 toolkit consumer 后，原 upstream submit 行为不变。

### 阶段三：类型化 domain workflow

- 在对应功能 RFC 接受后，实现一个只读 command 和一个复合 command。
- 推荐先实现 `/env list`，再实现 `/env init`；两者都只通过 environment domain API/workflow 工作。
- 验证 Agent prompt、Session parts、取消和 finalize 由 domain workflow 控制，而不是 command metadata 猜测。

### 阶段四：其他客户端 adapter

- Web/Desktop 和 CLI 根据各功能 RFC 声明的 client scope 接入同一 command-kit contract。
- adapter 使用各自已有的 CommandProvider/keymap，不复制 resolver。
- 每个客户端保留 upstream-first 兼容 fixture。

### 阶段五：评估 v2

只有 v1 消费者和兼容测试稳定后，才评估 server-owned discovery、无客户端执行或公开插件扩展。任何网络 API 都必须使用 feature detection 和版本化协议；legacy adapter 在完整弃用周期内保留。

## 验收条件

1. `packages/command-kit` 不依赖 UI、Server、SDK 或具体 feature。
2. 通用 prompt/UI 组件只有一个 toolkit integration point，不包含 fork-specific 命令字符串分支。
3. longest-match、alias、raw arguments、多行输入和冲突错误具有纯单元测试。
4. `/env init` 等复合命令可以通过可测试 domain workflow 表达条件步骤和 finalize。
5. 当前兼容矩阵中的上游命令来源均通过 upstream-first 兼容 fixture。
6. 未适配本 fork 的代表性上游插件可以正常加载并保持原行为。
7. 现有 `CommandV2`、`/api/command`、`session.command` 和生成 SDK 不发生未经版本化的行为变化。
8. UI 可以显示生效命令的 provenance 以及 winner/shadowed candidate；override drift 由静态 verifier 在 typecheck/build/CI 阶段阻止，运行时安装失败则保留 upstream candidate 并显示 warning。
9. capability 与实际 service 调用均可在测试中断言，配置只能收紧，不能扩大权限。
10. `/target`、`/env`、`/sync`、`/permissions`、`/expand` 和 `/delete` 没有各自维护通用输入解析分支。

## 非目标

- 在第一阶段设计声明式 workflow DSL；
- 让所有命令在同一进程执行；
- 在 v1 增加通用远程 `command.execute` endpoint；
- 在 v1 发布新的第三方插件 API；
- 强迫外部插件、MCP、Skill 或普通 custom command 迁移到 toolkit；
- 沙箱化任意第三方插件；
- 允许用户任意重写外部插件 handler；
- 在本 RFC 中定义 `/env`、Rexd 或同步功能的业务规则；
- 立即移除上游 legacy command/plugin API。

## v1 已解决的架构问题

1. registry 与 resolver 位于新的 runtime-neutral 私有 workspace package，不放入 Server、UI framework 或现有 prompt-command catalog。
2. v1 不合并 client/server executable handler，也不新增通用执行 endpoint；客户端 handler 调用类型化 domain API。
3. capability 在 v1 是静态上界、确认与策略输入，domain service 继续承担真正授权。
4. v1 不扩展现有 command endpoint 或 generated SDK；未来网络发现使用新的版本化协议。
5. legacy command 只投影 upstream 已知 metadata，无法可靠推断时保持 `legacy-opaque`。
6. v1 package 是仓库内部 API；稳定后是否公开给第三方插件由 v2 RFC 决定。

这些是 Accepted 决策，不再作为实现者可以自行更换的候选方案。实现原型可以调整类型命名和文件拆分，但如果需要改变上述六项边界，必须修订本 RFC。
