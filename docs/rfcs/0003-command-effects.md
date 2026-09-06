---
id: 0003
title: Core Command Toolkit and Upstream Compatibility
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

外部插件作者仍以对应 upstream 发布的 plugin API 为默认契约。只有主动检测并采用本 fork 扩展能力的插件，才直接使用新 toolkit 的公开扩展部分。

工具集至少应提供：

- command definition 与 registry；
- 单段和分层 command path 的统一解析；
- 参数 schema、帮助和补全接入点；
- provenance、shadowing 和冲突诊断；
- client/server execution context；
- confirmation、capability、取消、失败和 outcome 基础设施；
- Core services 调用约定；
- 上游来源 adapter；
- 面向 Core command 和下游 fork 的测试 harness。

## 已确认的 Core 消费者

以下 command family 必须使用本 toolkit 注册和实现，不得各自在输入组件中增加解析分支：

- RFC-0002 的 `/target`；
- RFC-0005 的 `/env`；
- 后续同步 RFC 的 `/sync`。

各功能 RFC 负责定义自己的业务流程、权限、失败和验收语义；RFC-0003 只提供共同基础设施和维护约束。其他新 Core command 默认也应使用 toolkit，除非其 RFC 明确说明无法使用的技术原因。

对应 upstream 版本原生支持的 slash command 与外部生态命令先通过 adapter 保持原实现和行为，不要求为了形式统一而立即重写。以后如果迁移某个上游原生命令到完整 toolkit API，必须有行为等价测试，并保持公开接口与插件观察到的生命周期不变。

## 必须满足的约束

1. 旧归档中把 `/env`、`/target`、`/cd`、`/sync` 等命令直接写入 prompt 提交函数的方式不得复用。
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

- definition plane：统一描述身份、路径、参数、来源、展示、兼容模式、声明能力和 executor placement；
- execution plane：由受信任的 handler 使用 Core services 编排实际 workflow。

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

## 核心模型

下面是概念模型，公共 Schema 应在实现阶段以独立 PR 确认：

```ts
interface CommandDefinition {
  id: string
  path: readonly string[]
  aliases?: readonly (readonly string[])[]
  title: string
  description?: string
  provenance: CommandProvenance
  arguments?: CommandArgumentSchema
  placement: "client" | "server"
  capabilities: readonly CommandCapability[]
  compatibility?: CommandCompatibility
  execute: CommandHandler
}
```

关键语义：

- `id` 是稳定身份，不因用户修改 alias 而变化；
- `path` 是用户输入路径；
- `provenance` 记录来源和外部 provider/plugin 标识；
- `placement` 说明 handler 在哪里运行，不代表它只能调用本地资源；
- `capabilities` 是可能使用的权限上界；
- `execute` 可以包含条件分支、等待 Agent 和成功后的收尾步骤。

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
3. handler placement 在 client 还是 server？为什么？
4. 业务逻辑位于哪个可复用 domain/feature service？
5. 可能使用哪些 capabilities？哪些步骤有副作用？
6. 哪一步可能调用 Agent、写入 Session 或影响模型上下文？
7. 确认、权限、取消、失败、重试和收尾语义是什么？
8. TUI、Web/Desktop、CLI 和 SDK 中哪些入口支持它？
9. 是否改变上游公开接口或 legacy 行为？兼容测试在哪里？
10. 是否包含 secret-bearing 输入或输出？如何避免泄漏？

命令特有业务逻辑不得放入通用 autocomplete、prompt submit 或 command palette 组件。

## 实现阶段

### 阶段一：兼容性基线

- 为所有上游命令来源建立 fixture 和行为快照。
- 固定 command list、执行、冲突、hook、Session part 和 Agent 调用的现有语义。
- 记录公开 SDK/plugin API 的兼容矩阵。

### 阶段二：内部 registry

- 引入稳定 identity、path、provenance、placement 和 capability 上界。
- 用 adapter 投影现有命令，不修改外部行为。
- 提供 longest-match 解析、来源检查和 shadowing 诊断。

### 阶段三：Core workflow API

- 提供窄的 command context 和统一 outcome。
- 将业务操作下沉到可复用 domain services。
- 首先迁移一个低风险 query，再迁移复合 `/env init`；每次迁移保持用户可见行为或明确记录变化。

### 阶段四：可选扩展 API

- 仅在内部 API 稳定后向插件公开。
- 使用 feature detection 和版本化能力。
- legacy adapter 在完整弃用周期内保留。

## 验收条件

1. 通用 prompt/UI 组件中不再包含 fork-specific 命令字符串分支。
2. `/env init` 等复合命令可以通过可测试 workflow 表达条件步骤和 finalize。
3. 当前兼容矩阵中的上游命令来源均通过兼容 fixture。
4. 未适配本 fork 的代表性上游插件可以正常加载并保持原行为。
5. 现有 command API 和生成 SDK 不发生未经版本化的破坏性变化。
6. UI 可以显示生效命令的 provenance，并诊断 shadowing。
7. 用户只能配置表现和收紧策略，不能制造违反 Session、上下文或权限不变量的组合。
8. 新增命令遵守维护清单，业务逻辑可脱离 UI 单独测试。
9. `/target`、`/env` 和 `/sync` 没有在通用输入组件中维护各自的命令解析分支。

## 非目标

- 在第一阶段设计声明式 workflow DSL；
- 让所有命令在同一进程执行；
- 强迫外部插件、MCP、Skill 或普通 custom command 迁移到 toolkit；
- 沙箱化任意第三方插件；
- 允许用户任意重写外部插件 handler；
- 在本 RFC 中定义 `/env`、Rexd 或同步功能的业务规则；
- 立即移除上游 legacy command/plugin API。

## 待实现验证

以下内容由实现原型验证，不改变本 RFC 的兼容原则：

1. 内部 registry 最适合位于 Core、Server 还是共享 package；
2. client/server handler 的发现结果如何合并且保持确定顺序；
3. capability token 是静态审查信息，还是同时用于 runtime service gating；
4. 新命令详情通过扩展 endpoint 还是新的版本化 endpoint 暴露；
5. 对 legacy plugin command 可以安全推断到什么程度，哪些必须保持 opaque。
6. toolkit 的哪些部分保持内部 API，哪些部分稳定后作为下游 fork/插件扩展 API 发布。
