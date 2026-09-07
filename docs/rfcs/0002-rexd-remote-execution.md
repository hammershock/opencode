---
id: 0002
title: Rexd Remote Execution
status: accepted
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-06
implemented-by:
  - https://github.com/hammershock/opencode/pull/86
depends-on:
  - 0001
  - 0003
supersedes: []
superseded-by: []
---

# RFC-0002：Rexd 远程执行

## 摘要

将远程执行作为 OpenCode 的核心能力。OpenCode 可以在启动后的 QuickStart 页面选择本地或 Rexd 远程 target，并为新会话选择该 target 上的工作目录。会话创建后，用户输入的 Shell 命令以及 Agent 对工作区的工具调用，都由同一个 Session Location 提供执行 scope。

Rexd 是 OpenCode 内建的远程执行实现，不作为 OpenCode 插件加载。远程 target 通过 SSH 连接并使用 Rexd；连接失败时不得静默回退到本机执行。

本 RFC 只扩展执行 scope，使现有执行能力可以由本地或远程 Location 提供。用户与 Agent 的隔离边界由 RFC-0001 定义；User Shell 持久化与补全由 RFC-0004 定义；环境加载由 RFC-0005 定义。这些功能的具体实现不属于本 RFC。

## 背景

OpenCode 当前以启动命令所在目录作为默认工作位置。虽然当前架构已经使用 `Location.Ref`、`LocationServiceMap` 和 Location-scoped services 表示会话的工作位置，但 `Location.Ref` 目前只能区分目录和 workspace，不能表达本地与远程执行 target。

归档中的早期 `remote-opencode-dev` 实现曾由 TUI 保存 target 状态并分别处理远程执行。后续 `rexd-integration` 分支已经完成一次架构重构，验证了 `LocationServiceMap`、内建 Rexd provider、Server target API 和 QuickStart picker 这一分层方案的可行性。

`rexd-integration` 是实现证据而不是本 RFC 的规范来源。新实现可以复用它的架构经验和测试场景，但必须针对当前 upstream 与本 RFC 重新实现；尤其不能直接继承其中未强制检查 capabilities、未替换全部 Location services、覆盖用户 Rexd 安装位置或依赖隐式 transport cleanup 的行为。

## 目标

1. 远程执行是 OpenCode Core 可以表达和路由的执行位置，不依赖插件。
2. Rexd 作为内建远程执行后端，通过 SSH 为远程 target 提供服务。
3. 同一会话的用户 Shell 命令与 Agent 工作区工具都以同一个 Session Location 为执行 scope；二者按照 RFC-0001 保持可变 Shell 状态隔离。
4. QuickStart 页面允许用户在发送第一条 prompt 前选择：
   - 本地或已配置的远程 target；
   - 所选 target 上的工作目录。
5. OpenCode 的启动目录只可作为本地目录的初始建议，不再是新会话不可选择的隐式工作位置。
6. 本地执行继续使用同一套 Location 接口，未启用远程 target 时保持现有行为。
7. QuickStart 直接调用结构化 target domain API，不要求用户通过 `/target` 创建新会话。
8. 用户可以从 QuickStart 的 target picker 进入向导，新增、编辑、测试和移除设备本地 target，无需手写配置文件。

## 非目标

本 RFC 不包含：

- 多设备同步或百度网盘同步；
- 运行中会话在不同 target 之间迁移；
- target 的云端共享；
- 远程环境变量管理；
- 自动调度、负载均衡或多节点容错；
- 容器编排；
- Rexd 插件兼容层；
- 独立于 QuickStart 流程的跨客户端 target 管理中心；
- 任意版本升级、后台自动更新或管理用户自行安装的 Rexd daemon；
- Web App 和 Desktop 的远程 target 选择界面。
- Shell 持久化、补全、环境继承或 `.env` 加载语义。
- 通用的运行中 Session `/target` 切换；v1 只允许 RFC-0009 从 `/sessions` 提供默认隐藏的实验性强制重绑定 workflow。

## 用户流程

1. 用户启动 OpenCode，进入 TUI QuickStart 页面。
2. QuickStart 显示当前选择的 target 和工作目录。
3. 用户可以选择 `local` 或一个已配置的 Rexd target；picker 同时提供 `Add target...` 和 `Manage targets...` 入口。
4. 新增或编辑 target 时，QuickStart 打开配置向导。向导生成稳定 ID，并收集显示名称、SSH 连接方式和远端工作位置；保存动作不要求额外确认，并在保存后自动探测。暂时无法连接时保留配置并标记为尚未验证，真正选择该 target 时显示连接错误且不创建 Session。
5. 用户在所选 target 上选择工作目录：
   - local 目录从本机文件系统选择；
   - Rexd 目录通过该 target 查询，不使用本机文件系统结果。
6. 用户提交第一条 prompt。
7. OpenCode 先验证 target 可连接且目录存在，再用该 Location 创建会话并提交 prompt。
8. 此后该会话中的用户 Shell 命令和 Agent 工作区工具都在同一 Location 执行，但不共享同一个 Shell 进程或可变状态。

如果 target 连接或目录验证失败，QuickStart 保留用户尚未提交的 prompt 和选择，不创建会话，也不回退到本地执行。

## 核心概念

### Target

Target 表示执行发生在哪台机器上：

```text
TargetRef = local | rexd(targetID)
```

`targetID` 是创建 target 时生成的设备本地 UUID，一经创建不可修改。target 配置另有设备内唯一、可修改的显示名称，并保存连接方式、Rexd 启动方式、workspace roots 和默认目录；凭据、SSH 配置和连接细节不写入 Session。

Session 以不可变 `targetID` 作为设备本地解析 identity，因此重命名显示名称不需要迁移历史 Session。Location metadata 可以保留非敏感的 `lastKnownTargetName` 作为 target 被移除后的恢复提示，但它不是 identity，不能用于自动匹配或连接。修改一个既有 ID 的连接配置必须视为更新同一个执行位置并留下可诊断的配置变更，不能复用该 ID 创建语义无关的新 target。

### Target 配置文件

target 定义由 OpenCode 而非 Rexd 拥有，使用 OpenCode 解析后的设备本地用户配置目录。该目录默认是 XDG config 下的 `opencode` 目录（通常为 `~/.config/opencode`），并遵守 OpenCode 已支持的配置目录 override。canonical 文件为：

```text
<OpenCode user config directory>/targets.jsonc
```

这是设备级全局配置，而不是项目配置。完整 target 定义不得从项目级 `.opencode` 或项目 `opencode.json(c)` 加载，避免仓库内容声明 SSH 主机、认证路径、任意 SSH 参数或远端命令，也避免把设备专属连接信息提交到 Git。未来若需要项目级默认位置，只能由单独规范定义一个非敏感的 target 名称和目录提示；提示不得创建 target、覆盖全局连接定义、绕过用户确认或触发自动连接。

之所以不继续使用旧实现的 `~/.config/rexd/targets.json`，是因为该 registry 表达的是 OpenCode 的执行位置、QuickStart 选择和 Session 恢复关系，而不是 Rexd daemon 自身的配置。将独立的 `targets.jsonc` 放在 OpenCode 全局配置目录中，也使 UI 可以原子更新 target，而不必重写并破坏用户主 `opencode.jsonc` 中的注释和其他设置。

配置使用带版本的顶层 schema：

```jsonc
{
  "version": 1,
  "targets": {
    "a20c4f65-7ad8-47ae-bc91-7f2b9476108d": {
      "name": "a100-2gpu",
      "transport": "ssh",
      "connection": {
        "type": "manual",
        "host": "example-host",
        "user": "hammer",
        "port": 22,
        "identityFile": "/path/to/key",
      },
      "defaultDirectory": "/home/hammer",
      "workspaceRoots": ["/"],
    },
  },
}
```

- target map key 是 Session 保存的不可变 UUID，`name` 是设备内唯一的可修改显示名称；
- v1 只接受 `ssh` transport；
- `connection` 是互斥 tagged union：`ssh-config` 只保存 host alias 并完全使用 OpenSSH 的解析结果；`manual` 使用结构化的 host、user、port 和可选 identity file，两种模式不能互相覆盖字段；
- `identityFile` 只保存控制设备路径引用，不复制私钥内容；高级 SSH 参数必须作为独立参数传递，禁止拼接 Shell command；
- `workspaceRoots` 用于准备 OpenCode 管理的 Rexd 配置，并仍须由握手返回值确认；它不能伪造服务端允许范围；
- wizard 默认把探测到的远端用户 HOME 作为 `defaultDirectory`，把 `/` 作为 `workspaceRoots`；字段说明必须明确前者是新 Session 的初始目录，后者是 Rexd 文件能力和 cwd 的允许边界，并警告 `/` 代表最大路径范围、workspace roots 不是任意 Shell 命令的 sandbox；
- `workspaceRoots` 与 `defaultDirectory` 的文本输入必须支持基于当前 target 草稿的远端目录补全。Tab 展示逐行候选并可补齐公共前缀；候选只能来自目标机器，不能读取控制设备上的同名路径。远端 HOME 无法探测时不得把 `/` 冒充为 HOME；应允许留空并显示探测诊断；
- `defaultDirectory` 必须位于至少一个配置并经握手确认的 workspace root 内；
- 未知字段、重复语义和非法类型产生带 JSON path 的配置诊断；
- 文件缺失等价于没有配置远程 targets；文件损坏不影响 local Location，但 QuickStart 必须显示配置错误；
- target 配置不属于 Session/cloud sync payload。未来如同步非敏感 target metadata，必须由同步 RFC 另行定义 allowlist。

### Target 管理与配置向导

归档中的 `remote-opencode-dev` 曾实现 `/target add` 向导，依次收集 alias、SSH host、user、默认远端目录、workspace roots 和 Rexd command，并直接由 TUI 写入 `~/.config/rexd/targets.json`。本 RFC 保留其“可以在 UI 中完成配置”的产品能力，但不继承 TUI 直接访问文件、要求用户填写 managed daemon command 或让 Rexd 拥有 OpenCode target registry 的实现边界。

QuickStart target picker 必须提供：

- `Add target...`：创建配置草稿并进入分步向导；
- `Manage targets...`：查看状态，并执行编辑、测试连接、重命名和移除；
- 空 target 列表中的直接创建入口。

`/target` 使用 RFC-0003 toolkit，作为打开同一 target registry manager 的可信 Core command；`/target add` 可以直接进入同一新增向导。它们只能管理、测试和选择配置视图，不能修改当前 Session Location。既有 Session 的重绑定只能通过 RFC-0009 workflow。

v1 向导至少支持：

1. 自动生成不可变 target ID，并设置设备内唯一、可修改的显示名称；
2. 选择已有 SSH Config host alias，或切换到互斥的 manual 模式填写 host、user、port 和可选 identity file；
3. 设置一个或多个远端 workspace roots，以及可选默认工作目录；新建时分别默认 `/` 和探测到的远端 HOME，并为两个字段提供上述用途与安全边界说明以及远端 Tab 目录补全；
4. 展示即将使用的主机身份校验策略，不自动接受未知 host key；
5. 测试 SSH、环境检测、managed daemon 准备和 Rexd 握手，并按阶段展示经过脱敏的错误；
6. 保存后自动执行连接探测；保存动作本身不增加一次摘要确认。探测失败时保留配置并明确标记为 `unverified`，只有稍后成功 prepare 后才可用于创建 Session。真正选择不可用 target 时才展示连接错误并拒绝创建，且不得回退 local。

managed daemon 的命令和安装路径由本 RFC 的 prepare 流程派生，不作为普通向导必填项。为兼容自行准备的 Rexd，高级配置可以提供显式 command，但必须标明它绕过自动安装且仍受完整握手和 capability 校验。

TUI 不直接读写 `targets.jsonc`，也不自行执行 SSH。Core/Server 提供结构化的 target registry CRUD、校验、连接测试和 prepare API，所有客户端复用同一实现。配置写入必须做到原子替换、并发冲突检测，并尽量保留 JSONC 注释、未知的兼容字段和未修改 target；文件权限不得扩大。重命名只更新显示名称；移除 target 只使引用其 ID 的 Session 进入 unresolved，不删除 Session。

QuickStart 的 `Execution Target` picker 与 target manager 必须在打开时异步、非阻塞地探测每个已配置 target，并以简洁的 `checking`、`ready`、`unavailable` 或 `invalid` 状态展示。聚焦失败项时可以显示脱敏的阶段和原因；探测失败不得关闭面板、切换选择或导致 TUI crash。用户可主动刷新。此处健康探测只检查现有 SSH/Rexd 可达性、握手与能力，不执行 daemon 安装或升级；完整 managed-daemon prepare 仍只在激活 target/创建 Session 的准备阶段运行。

### Location

Location 表示一次会话绑定的完整工作位置：

```text
LocationRef {
  target
  directory
  workspaceID?
  lastKnownTargetName?
}
```

其中 `directory` 是在对应 target 上验证并规范化后的绝对路径。它表示 Session Location directory，不等同于 RFC-0004 中 User Shell 自己维护的可变 `$PWD`。相同的目录字符串位于不同 target 时，是两个不同的 Location。`lastKnownTargetName` 只用于显示和恢复向导，不含连接详情，也不改变 `targetID` 的解析规则。

为了兼容已有本地 Session，缺少 target 的历史 Location 按 `local` 解释。新代码不得依靠进程当前目录推断一个已经创建的 Session 的执行位置。

## 执行边界

OpenCode 的控制面仍运行在启动 OpenCode 的设备上，包括 TUI、Server、模型请求和会话调度。与工作区有关的执行面由所选 Location 提供：

- 进程与 Shell 命令；
- 文件读取、写入、编辑、搜索和监听；
- PTY；
- 依赖工作目录或工作区文件系统的内建 Agent 工具。

纯控制面工具不需要搬到远端，例如向用户提问或管理 OpenCode 自身 UI 状态。判断标准是工具是否访问会话工作区或在工作环境中执行，而不是工具由用户还是 Agent 触发。

## 架构方案

### 1. Location 成为唯一执行位置

扩展 Schema 中的 `Location.Ref`，使其包含 target。Session 创建后持久化完整 Location。所有需要工作区环境的 Server API 和 Session 执行都从 Location 获取服务，不从 OpenCode 进程的 `cwd`、`os.homedir()` 或本机全局状态重新推断。

### 2. LocationServiceMap 按 target 构建服务

`LocationServiceMap` 根据 `Location.Ref.target` 选择 Location service provider：

```text
local target -> Local Location services
rexd target  -> Rexd Location services over SSH
```

Rexd provider 至少为远程 Location 提供与工作区有关的进程、文件系统、搜索和 PTY 能力；文件监听遵循本 RFC 的可选 watcher 规则。上层调用方只依赖 Core service contract，不包含 `if remote`、SSH 命令或 Rexd RPC 分支。

远端缺少某项可选能力时，对应 service 必须显式报告 unavailable 或使用本 RFC 允许的远端降级实现；绝不能继续实例化访问控制设备文件系统或进程的 local service。

### 3. Rexd 是内建 provider

Rexd provider 随 OpenCode 构建并在应用组合阶段注册，不通过用户插件系统加载。插件可以使用已解析的 Location 能力，但不能负责创建 OpenCode 的基础远程执行环境。

Rexd 与 OpenCode Core 之间仍通过明确的 service contract 隔离，以便独立测试本地和远程实现。“内建”不意味着把 SSH/Rexd 判断散落到每个工具中。

### 4. Shell 与 Agent 工具统一路由

用户在 TUI Shell 模式提交的命令，必须通过 Session 的 Location 执行。Agent 的 Shell、文件和其他工作区工具由同一个 Location-scoped registry 和 services 构造。本 RFC 只要求它们共享执行 Location，不要求它们共享同一个 Shell 进程或可变 Shell 状态。

不得存在以下行为：

- 用户 Shell 在远端执行，但 Agent Shell 在本地执行；
- Shell 在远端执行，但文件读取或搜索在本地执行；
- 远程调用失败后，同一命令自动改为本地执行；
- 远程目录补全读取本机目录；
- 工具自行读取全局“当前 target”绕过 Session Location。

### 5. QuickStart 负责选择新会话 Location

扩展现有 `HomeSessionDestination`，使 QuickStart 同时保存 target 和 directory。首页清楚显示当前选择，例如：

```text
local · /Users/hammer/workspace/project
gpu-server · /data/project
```

切换 target 后，目录选择和补全立即切换到该 target 的文件系统。启动目录可以作为 local 的初始值；远程 target 的初始目录来自其远端位置，不能把本机启动目录直接复用为远端路径。

用户确认工作目录后，QuickStart 必须在写入待创建 Session 的 Location 前执行一次 target-side 预检。结果分为既存目录、不存在和非目录：既存目录可以继续；非目录必须拒绝；不存在时必须弹出二次确认，只有用户明确同意后才通过类型化的 Location filesystem API 递归创建。取消确认或创建失败不得修改当前 destination，也不得创建 Session。local 与 Rexd 使用相同交互；Rexd 的检查和创建发生在目标机器，并受 negotiated workspace roots 限制。该能力不是通用远程 command execute API。

提交第一条 prompt 的顺序固定为：

```text
解析 target
  -> 建立 Rexd/SSH 连接（远程时）
  -> 验证所选目录
  -> 创建绑定该 Location 的 Session
  -> 提交第一条 prompt
```

以上步骤在 Session 创建前失败时，不产生半创建的 Session。

### 6. Target registry 是 Core domain

target registry 的读取、诊断、修改、连接测试与 managed daemon prepare 属于 Core/Server domain。QuickStart、未来 Desktop/Web 客户端以及可信的内建命令只调用结构化 API，不分别解释配置格式。API 必须区分以下状态：

```text
configured -> unverified | ready | unavailable | invalid
```

`unverified` 只表示配置已经保存但尚未成功验证，不允许跳过 Session 创建前的连接、握手和目录校验。配置文件中的缓存状态不能成为 target 可用性的事实来源。

## 失败语义

- target 不存在：拒绝创建会话，并在 QuickStart 显示错误。
- SSH 或 Rexd 连接失败：拒绝创建或执行，不回退本地。
- 目录不存在或不可访问：拒绝创建会话。
- 执行中连接中断：当前操作以明确的远程执行错误结束；不得报告为本地成功。
- OpenCode 无法确定远端进程是否已经执行：报告结果未知，不自动重复可能有副作用的操作。

## Rexd 协议边界

### 基线协议与能力协商

OpenCode 通过 SSH stdio 使用 Rexd JSON-RPC，并以 `session.open` 返回的协议版本、server version、capabilities、limits 和 workspace roots 为服务端事实来源。本机 target 配置可以声明期望能力，但不能伪造服务端能力。

一个远程 Location 激活前必须确认：

- protocol 与本实现支持的 `rexd/1` 基线兼容；
- `exec`、`fs`、`events` 和 `pty` capabilities 均可用；
- daemon 返回至少一个允许所选 directory 的 workspace root；
- 服务端 limits 可以支持 OpenCode 本次操作，客户端请求只能在 limits 以内进一步收紧。

`http` capability 不是 SSH stdio profile 的要求。能力不满足时，QuickStart 显示缺失项并拒绝创建 Session。

Rexd v1 没有稳定的文件监听方法。v1 远程 Location 明确将 watcher 标记为 unavailable，不实现隐式轮询，也不得监听控制设备上的同名路径。依赖 watcher 的上层功能必须显式降级；未来增加远端原生 watcher 或 polling adapter 需要单独设计性能、取消和一致性边界。

### 方法映射

OpenCode Core 只依赖 Location services，Rexd adapter 负责映射：

```text
process/shell  -> exec.start + exec events + exec.kill/wait
file read      -> fs.stat + fs.read
file mutation  -> fs.write + fs.edit/fs.patch
search/list    -> fs.list + fs.glob，必要时使用受控 remote exec
terminal PTY   -> pty.open/input/resize/close + pty events
```

上层工具不得直接构造 Rexd method 名称。adapter 必须验证响应 schema、事件所属 session/process、单调序号、输出上限和结构化错误码。

## Managed daemon 准备

自动准备与安装基线 Rexd daemon 是本 RFC 的核心职责。默认实现使用 OpenCode 自己的版本化目录和最小配置，不覆盖用户安装的 `rexd` binary 或 `~/.config/rexd`：

```text
remote data dir/opencode/rexd/<baseline-version>/rexd
remote config dir/opencode/rexd/config.toml
```

远端目录的具体展开遵循检测到的平台约定，不能假设所有 target 都是 Linux `/home/<user>`。

准备事务按以下顺序执行：

```text
建立 SSH
  -> 检测 OS、architecture、HOME 与所需基础工具
  -> 检查 OpenCode 管理的基线 binary
  -> 缺失时下载对应固定版本并校验 checksum
  -> 原子安装并生成最小配置
  -> 启动 SSH stdio transport
  -> session.open 握手
  -> 校验版本、capabilities、limits 和 roots
  -> 验证 directory
```

实现必须满足：

- 安装 manifest 固定 daemon 版本、各平台 artifact 和 checksum，不解析 `latest`；
- 不使用 `sudo`，不修改系统级 service，不覆盖用户管理的 binary/config；
- 并发准备同一 target 时使用远端锁或等价的原子机制；
- 下载、校验或替换失败时保留此前完整可用的 managed baseline；
- 已配置的显式 Rexd command 只有在握手满足本 RFC 时才可使用；
- unsupported platform、SSH authentication、缺少工具、下载、checksum、install、launch、handshake、capability 和 directory validation 分别产生可识别的错误阶段；
- QuickStart 显示可操作的摘要，诊断日志保留经脱敏的底层 stderr 和阶段信息。

“尽力而为”表示实现应检测环境并自动完成安全、无特权的准备；不表示可以忽略校验、修改系统环境或在失败后本地回退。

v1 managed install 支持 Linux `x86_64`、Linux `arm64`，以及能够通过 SSH 进入 Linux userspace 的 WSL `x86_64/arm64`。其他 OS/architecture 必须在下载前报告 unsupported platform；用户仍可通过显式 command 配置接入已经自行准备、且握手满足本 RFC 的兼容 Rexd，但 OpenCode 不承诺为该平台自动安装。

## 连接与 Session 生命周期

持久的 OpenCode Session 与临时的 Rexd protocol session 相互独立：OpenCode Session 只保存设备本地不可变 target ID 和 directory；Rexd `session_id`、SSH process 与 negotiated state 都是当前 OpenCode 进程的运行时资源，不写入数据库或同步数据。

1. 远程 Location 首次使用时按需建立一个 connection lease，完成 `session.open` 后供该 Location 的文件、进程和 PTY services 复用。
2. 不为每次工具调用重新建立 SSH。JSON-RPC transport 可以并发复用，但必须按 request、process、PTY 和 session 正确分发响应与事件。
3. 正常释放时先停止或关闭该 lease 所属的非 detached process/PTY，调用 `session.close`，再关闭 SSH transport。
4. 本 RFC 禁止创建 detached remote process；OpenCode Session 的持久化不能被误解为远端进程托管。
5. 存在运行中 process、等待中的请求或活跃 PTY 时，lease 不得被 idle eviction 回收。空闲 lease 可以按实现策略回收。
6. transport 意外断开时，该 lease 立即失效；当前操作返回远程断线错误。无法确认是否产生副作用时标记 outcome unknown，禁止自动重试。
7. 后续新操作可以创建新 lease 和新的 Rexd `session_id`，但必须重新握手并重新验证原 target 与 directory。只读操作是否自动重试由调用方显式决定，adapter 不做透明重试。
8. OpenCode 正常退出时尽力执行 graceful close；异常退出依赖 SSH stdio 断开和 Rexd 清理非 detached 子进程。实现必须用测试确认不会遗留专用 SSH、Rexd、process 或 PTY。
9. 一个 lease 的故障不得使同 target 的其他 OpenCode Session 静默切换本地，也不得破坏不共享该 lease 的 Location。

## 安全边界

- SSH 凭据和 target 连接配置保留在控制设备本地，不写入 Session 或模型上下文。
- 日志和工具输出不得包含私钥或认证材料。
- Rexd target 未通过验证前，不得创建绑定该 target 的 Session。
- 不自动接受未知 SSH 主机身份。
- managed daemon 下载必须经过固定 checksum 校验；配置文件权限应限制为远端用户可读写。
- workspace roots 约束 Rexd filesystem RPC 和 command cwd，但不构成对任意 Shell 命令的完整 sandbox；UI 与文档不得把它描述成主机隔离。

## 兼容性

- 没有显式 target 的历史 Session 视为 local。
- 恢复远程 Session 时，当前设备找不到对应 target ID、连接失败或历史 directory 不再有效，Session 保持 unresolved 并展示具体原因；不得静默改为 local、默认 target 或默认目录。
- unresolved Session 仍可只读打开并查看完整对话、工具结果和 metadata，但必须禁用 prompt 提交、User Shell、Agent 工具、Terminal、文件操作及其他依赖 Location 的执行入口。RFC-0009 的恢复向导可以补建原 target 配置、建立 portable label binding，或在实验开关开启时重绑定到另一 Location；只有解析与完整 Location 验证成功后才能恢复写入和执行。
- 选择 local 时，现有 Shell、文件、PTY 和 Agent 工具行为保持不变。
- 公共 Schema 或 HttpApi 发生变化后，必须通过仓库生成脚本更新 Client/SDK，不得直接编辑 generated 文件。
- 旧实现的 `~/.config/rexd/targets.json` 不是新的 active 配置源。新文件不存在而旧文件存在时，QuickStart/target manager 应提供一次显式导入：为每个合法旧 target 生成 UUID，展示 alias/manual 转换结果和字段诊断，再写入 canonical `targets.jsonc`；不得静默删除或修改旧文件，也不得长期合并两个来源。
- 旧配置中的显式 Rexd command、workspace roots 和其他可表达字段应尽量导入；不能安全转换的字段必须逐项报告，由用户确认或修正。
- 旧归档分支中的 per-Session TUI 状态不保证迁移；只有 target registry 提供上述导入路径。

## 实现阶段

### 阶段一：Location contract

- 为 Location 增加稳定的 target 表达。
- 定义 local 与 Rexd provider 共同满足的 service contract。
- 添加 Location 编码、兼容性和 service routing 测试。

### 阶段二：Rexd provider

- 实现 managed daemon prepare、SSH stdio、握手、capability/limit 校验和连接 lease。
- 覆盖进程、文件、搜索和 PTY 的核心路径；远程 watcher 按本 RFC 显式标记 unavailable。
- 对 local 与 Rexd provider 运行共同的 contract tests。

### 阶段三：统一执行入口

- 用户 Shell 命令使用 Session Location。
- Agent 工作区工具使用 Session Location。
- 遵守 RFC-0001 已确定的用户/Agent Shell 隔离语义；User Shell runtime cwd 与补全遵守 RFC-0004。
- 删除或禁止绕过 Location 的远程专用分支。

### 阶段四：Target registry 与向导

- 在 Core/Server 实现全局 target registry 的 schema、JSONC 诊断、原子 CRUD、连接测试与 prepare API。
- 在 QuickStart target picker 中实现新增和管理入口，以及 SSH Config/manual 两种向导路径。
- 实现旧 `~/.config/rexd/targets.json` 的显式一次性导入流程。

### 阶段五：QuickStart Location

- 选择 local 或已配置 Rexd target。
- 选择或补全所选 target 上的目录。
- 在验证 Location 后原子地创建 Session 并提交 prompt。

## 实现约束

- 不从归档仓库整块复制旧实现；只允许复用经重新审查的协议、算法或测试场景。
- 不把 Rexd 重新实现为插件。
- 不在 TUI 中持有一套独立于 Core/Session 的执行位置事实来源。
- 不把远程判断散布到各个工具实现中。
- 不在本 RFC 的实现 PR 中加入非目标功能。

## 验收条件

以下条件全部满足后，本 RFC 才能标记为 `implemented`：

1. QuickStart 可以选择 local 或已配置 target，并完成远端目录补全、验证和原子 Session 创建；整个流程不依赖 `/target`，失败时保留尚未提交的 prompt。
2. QuickStart 可以通过 Core/Server API 新增、编辑、测试、重命名和移除 target；TUI 不直接读写配置或执行 SSH。保存不需要预先确认，验证失败时保留配置并展示实际错误；未验证 target 不能创建 Session。
3. Session 持久数据只包含设备本地不可变 target ID 和规范化 directory，显示名称、连接配置与运行时 Rexd session 不进入 Session 或同步数据。
4. managed daemon 的支持平台安装、已安装复用、并发准备、checksum 失败和 unsupported platform 均有测试。
5. 握手强制检查 protocol、server version、`exec`、`fs`、`events`、`pty`、limits 和 workspace roots。
6. User Shell、Agent process、read/write/edit/patch/list/glob/search 与 Terminal PTY 均通过同一个远程 Location；测试证明没有访问控制设备的同名路径。
7. graceful close、transport crash、超时、中断、OpenCode 退出和重新连接均有 lifecycle 测试；副作用不明的操作不会透明重试。
8. target 缺失、认证失败、安装失败、握手失败、能力不足和 directory 失效均产生分阶段、可展示且经过脱敏的错误，不回退本地。
9. local Location 与没有 target 的历史 Session 保持 upstream 行为。
10. 所有受影响 package 的 typecheck 和定向测试通过，生成代码与公共 API 一致。
11. target 只从解析后的 OpenCode 用户配置目录加载；项目配置不能注入完整 target，连接详情不进入 Session 或同步 payload。
12. 旧 `~/.config/rexd/targets.json` 可以经用户确认导入 canonical 文件，导入不会修改旧文件，也不会把两个文件长期作为并列配置源。
13. target 被移除或无法解析时，Session 可以只读打开；所有 Location-dependent 操作保持禁用，并可通过 RFC-0009 补建原配置、建立 portable binding 或实验性 rebind 恢复。
