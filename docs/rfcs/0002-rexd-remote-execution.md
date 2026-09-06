---
id: 0002
title: Rexd Remote Execution
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

# RFC-0002：Rexd 远程执行

## 摘要

将远程执行作为 OpenCode 的核心能力。OpenCode 可以在启动后的 QuickStart 页面选择本地或 Rexd 远程 target，并为新会话选择该 target 上的工作目录。会话创建后，用户输入的 Shell 命令以及 Agent 对工作区的工具调用，都由同一个 Session Location 提供执行 scope。

Rexd 是 OpenCode 内建的远程执行实现，不作为 OpenCode 插件加载。远程 target 通过 SSH 连接并使用 Rexd；连接失败时不得静默回退到本机执行。

本 RFC 只扩展执行 scope，使现有执行能力可以由本地或远程 Location 提供。用户与 Agent 的隔离边界由 RFC-0001 定义；User Shell 持久化与补全由 RFC-0004 定义；环境加载由 RFC-0005 定义。这些功能的具体实现不属于本 RFC。

## 背景

OpenCode 当前以启动命令所在目录作为默认工作位置。虽然当前架构已经使用 `Location.Ref`、`LocationServiceMap` 和 Location-scoped services 表示会话的工作位置，但 `Location.Ref` 目前只能区分目录和 workspace，不能表达本地与远程执行 target。

归档中的旧实现证明了 Rexd 工作流的可行性，同时也暴露了不可继续沿用的问题：target 状态主要由 TUI 保存，Shell、文件和工具执行存在各自的远程分流逻辑，执行位置没有成为统一的核心概念。本 RFC 只保留产品需求，不继承旧实现的结构。

## 目标

1. 远程执行是 OpenCode Core 可以表达和路由的执行位置，不依赖插件。
2. Rexd 作为内建远程执行后端，通过 SSH 为远程 target 提供服务。
3. 同一会话的用户 Shell 命令与 Agent 工作区工具都以同一个 Session Location 为执行 scope；二者按照 RFC-0001 保持可变 Shell 状态隔离。
4. QuickStart 页面允许用户在发送第一条 prompt 前选择：
   - 本地或已配置的远程 target；
   - 所选 target 上的工作目录。
5. OpenCode 的启动目录只可作为本地目录的初始建议，不再是新会话不可选择的隐式工作位置。
6. 本地执行继续使用同一套 Location 接口，未启用远程 target 时保持现有行为。

## 非目标

本 RFC 不包含：

- 多设备同步或百度网盘同步；
- 运行中会话在不同 target 之间迁移；
- target 的云端共享；
- 远程环境变量管理；
- 自动调度、负载均衡或多节点容错；
- 容器编排；
- Rexd 插件兼容层；
- QuickStart 之外的完整 target 管理界面；
- 自动安装、升级或管理远端 Rexd daemon；
- Web App 和 Desktop 的远程 target 选择界面。
- Shell 持久化、补全、环境继承或 `.env` 加载语义。

## 用户流程

1. 用户启动 OpenCode，进入 TUI QuickStart 页面。
2. QuickStart 显示当前选择的 target 和工作目录。
3. 用户可以选择 `local` 或一个已配置的 Rexd target。
4. 用户在所选 target 上选择工作目录：
   - local 目录从本机文件系统选择；
   - Rexd 目录通过该 target 查询，不使用本机文件系统结果。
5. 用户提交第一条 prompt。
6. OpenCode 先验证 target 可连接且目录存在，再用该 Location 创建会话并提交 prompt。
7. 此后该会话中的用户 Shell 命令和 Agent 工作区工具都在同一 Location 执行，但不共享同一个 Shell 进程或可变状态。

如果 target 连接或目录验证失败，QuickStart 保留用户尚未提交的 prompt 和选择，不创建会话，也不回退到本地执行。

## 核心概念

### Target

Target 表示执行发生在哪台机器上：

```text
TargetRef = local | rexd(targetID)
```

`targetID` 引用本机已有的 Rexd/SSH target 配置。凭据、SSH 配置和连接细节不写入 Session；Session 只持久化稳定的 target 引用。

### Location

Location 表示一次会话绑定的完整工作位置：

```text
LocationRef {
  target
  directory
  workspaceID?
}
```

其中 `directory` 必须属于 `target` 的文件系统。相同的目录字符串位于不同 target 时，是两个不同的 Location。

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

Rexd provider 至少为远程 Location 提供与工作区有关的进程、文件系统、搜索、监听和 PTY 能力。上层调用方只依赖 Core service contract，不包含 `if remote`、SSH 命令或 Rexd RPC 分支。

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

提交第一条 prompt 的顺序固定为：

```text
解析 target
  -> 建立 Rexd/SSH 连接（远程时）
  -> 验证所选目录
  -> 创建绑定该 Location 的 Session
  -> 提交第一条 prompt
```

以上步骤在 Session 创建前失败时，不产生半创建的 Session。

## 失败语义

- target 不存在：拒绝创建会话，并在 QuickStart 显示错误。
- SSH 或 Rexd 连接失败：拒绝创建或执行，不回退本地。
- 目录不存在或不可访问：拒绝创建会话。
- 执行中连接中断：当前操作以明确的远程执行错误结束；不得报告为本地成功。
- OpenCode 无法确定远端进程是否已经执行：报告结果未知，不自动重复可能有副作用的操作。

## 安全边界

- SSH 凭据和 target 连接配置保留在控制设备本地，不写入 Session 或模型上下文。
- 日志和工具输出不得包含私钥或认证材料。
- Rexd target 未通过验证前，不得创建绑定该 target 的 Session。
- 不自动接受未知 SSH 主机身份。

## 兼容性

- 没有显式 target 的历史 Session 视为 local。
- 选择 local 时，现有 Shell、文件、PTY 和 Agent 工具行为保持不变。
- 公共 Schema 或 HttpApi 发生变化后，必须通过仓库生成脚本更新 Client/SDK，不得直接编辑 generated 文件。
- 本 RFC 不保证旧归档分支中的 Rexd 数据或 TUI 状态可以直接迁移。

## 实现阶段

### 阶段一：Location contract

- 为 Location 增加稳定的 target 表达。
- 定义 local 与 Rexd provider 共同满足的 service contract。
- 添加 Location 编码、兼容性和 service routing 测试。

### 阶段二：Rexd provider

- 实现通过 SSH 使用 Rexd 的 Location services。
- 覆盖进程、文件、搜索、监听和 PTY 的核心路径。
- 对 local 与 Rexd provider 运行共同的 contract tests。

### 阶段三：统一执行入口

- 用户 Shell 命令使用 Session Location。
- Agent 工作区工具使用 Session Location。
- 遵守 RFC-0001 已确定的用户/Agent Shell 隔离语义；持久 Shell 与补全遵守 RFC-0004。
- 删除或禁止绕过 Location 的远程专用分支。

### 阶段四：QuickStart

- 选择 local 或已配置 Rexd target。
- 选择或补全所选 target 上的目录。
- 在验证 Location 后原子地创建 Session 并提交 prompt。

## 验收条件

以下条件全部满足后，本 RFC 才能标记为 `implemented`：

1. QuickStart 可以选择 local target 和本地目录，并在该目录创建 Session。
2. QuickStart 可以选择已配置的 Rexd target，并从远端查询和选择目录。
3. 在远程 Session 中执行用户 Shell 命令（例如 `pwd`）返回远端结果。
4. 在尚未改变 User Shell 状态时，让 Agent 在同一 Session 调用 Shell，两者都以 Session Location 的远端目录启动。
5. Agent 读取、写入、搜索文件时只访问远端工作目录。
6. PTY 和文件监听等已纳入范围的 Location 能力不访问本机对应路径。
7. 断开远程连接后，操作明确失败且没有在本机执行。
8. target 或目录验证失败时，不创建 Session，QuickStart prompt 不丢失。
9. local Session 的现有相关测试保持通过。
10. 所有受影响 package 的 typecheck 和定向测试通过，生成代码与公共 API 一致。

## 实现约束

- 不从归档仓库整块复制旧实现；只允许复用经重新审查的协议、算法或测试场景。
- 不把 Rexd 重新实现为插件。
- 不在 TUI 中持有一套独立于 Core/Session 的执行位置事实来源。
- 不把远程判断散布到各个工具实现中。
- 不在本 RFC 的实现 PR 中加入非目标功能。
