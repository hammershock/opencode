---
id: 0009
title: Session Target Resolution and Location Rebinding
status: accepted
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-11
implemented-by:
  - https://github.com/hammershock/opencode/pull/86
depends-on:
  - 0001
  - 0002
  - 0004
  - 0005
supersedes: []
superseded-by: []
---

# RFC-0009：Session Target 缺失恢复与 Location 重绑定

## 摘要

为既有 Session 定义统一的 target resolution 状态和恢复界面。Session 从云端同步到新设备但 portable target 尚未绑定，或者设备本地 target 配置被移除时，用户可以只读打开 Session、配置缺失的逻辑 target，或者显式将 Session 重绑定到另一个已有 target。

“补全当前逻辑 target 的本地配置”和“更换 Session Location”是两种不同操作：前者恢复原引用，不修改 Session Location revision；后者保留对话历史但更换后续工具和 Shell 所看到的工作环境，仍是默认隐藏的实验性能力。本 RFC 不是 RFC-0002 QuickStart 新建 Session 主流程的一部分，也不提供通用 `/target` 中途切换命令。

## 动机与风险

同步或设备变化后，Session 原 Location 可能无法恢复：云端事件只有 portable target label，而新设备尚无对应 binding；本地 registry 中被 Session 引用的 target ID 也可能已经被移除。用户还可能有意在另一机器或目录继续同一段对话。直接修改 Location 有明显风险：历史工具输出、文件路径和 Agent 对代码状态的理解可能不再对应新工作区。

因此 target 缺失时必须显式提示恢复选项，不能自动连接同名 target 或静默回退到 local。只读打开和为原逻辑 target 建立本地配置属于正常恢复能力；只有把 Session 改到另一个逻辑 target 的 rebind 才是实验性高级操作。

## Target resolution 状态

Session 打开前，Core 将 Location 解析为以下状态之一：

- `resolved`：设备本地 target ID 或 portable label binding 能解析到有效 target definition；
- `missing_local_target`：Session 引用设备本地 target ID，但 registry 已不存在该 definition；
- `unbound_portable_target`：同步 Session 携带 portable target label，但本设备尚未建立 binding；
- `target_unavailable`：definition/binding 存在，但连接、Rexd、目录或环境验证失败。

后三种状态统一称为 unresolved，但 UI 必须展示具体原因。Session Location 保留非敏感的 `lastKnownTargetName` 或 portable label 作为恢复提示；它不是连接配置，也不能参与自动匹配。认证失败、设备离线等 `target_unavailable` 不应诱导用户重复创建同名 target，必须优先提供重试与编辑现有配置。

## 入口与开关

- unresolved Session 在 `/sessions` 和直接打开时始终显示恢复提示，不受实验开关控制；用户可选择 `Open read-only` 或 `Resolve target...`。
- `Resolve target...` 根据具体原因提供：配置缺失 target、将 portable label 绑定到已有/新建 target、编辑现有 target、重试验证，以及重绑定到其他 target。
- 设备级用户实验设置只控制 `Rebind to another target...` / `Force rebind location...`；默认关闭。该 action 必须标注 `Experimental` 和 `Not recommended`，不能成为默认恢复建议。
- 进入流程时保留客户端尚未提交的 prompt draft；取消和失败不能修改 draft。
- 正常恢复入口只用于 unresolved Session；实验性强制 rebind 允许从当前、历史或 unresolved Session 发起，旧 Location 不可连接不影响选择新 Location。
- v1 不注册 `/target` 形式的中途切换命令。

## Unresolved 恢复流程

### 只读打开

只读模式保留完整对话、工具结果和 metadata。prompt 编辑器仍可输入、编辑、粘贴和使用 slash autocomplete，但普通 prompt 提交必须在创建 Session message、写入 prompt history、optimistic render 或模型调用前被拒绝，并完整保留 draft。User Shell、Agent tools、Terminal、文件访问及其他 Location-dependent mutation 继续禁用。

Slash command 由 command toolkit 的 `readOnly` metadata 在 autocomplete 展示和 winner/alias 解析后、handler 或 `session.command` 执行前统一控制；只读 Session 的 autocomplete 只展示显式标记为 `readOnly: true` 的 command，也只有这些 command（例如 `/exit`、`/quit`、`/q` 和 `/sessions`）可以执行。完整手输的非只读 command 仍在 dispatch 前拒绝并保留输入。外部 custom command、MCP prompt、Skill 和 plugin command 不需要修改既有接口，未声明 metadata 时默认拒绝且不展示。用户可以随时从 Session banner 或 `/sessions` 重新进入恢复向导。

### 恢复被移除的本地 target

当状态为 `missing_local_target` 时，向导显示 `lastKnownTargetName`，并允许用户：

1. 使用 target 配置向导重新填写连接信息；保存时恢复 Session 已引用的原 target ID，而不是生成另一个 ID；该受限操作必须明确列出会同时恢复的所有引用 Session；
2. 在实验性 rebind 开启时，把当前 Session 显式重绑定到一个已有 target。

如果该 Session 曾参与 RFC-0010 同步，云端保存的 portable target name/label 可以作为向导中的名称、机器用途和工作位置参考；它不包含 SSH 连接信息，也不能自动选择 host、credential 或已有本地 target。

恢复原 ID 只修复设备本地 registry，不产生 Location revision，也不改变 Session directory。它是 registry 级修复：本设备上引用同一缺失 target ID 的 Session 形成一个恢复批次，验证成功后可以一起恢复 resolved。向导必须在保存前列出该批次。保存后仍必须重新执行连接、Rexd、workspace root、各 Session directory 和 RFC-0005 环境验证；某个 Session 的目录或环境验证失败时，该 Session 单独保持 unresolved，不能让整个 registry 修复回滚。普通 target 创建流程不得任意指定或复用 ID，只有针对当前缺失引用的恢复 transaction 可以执行该操作。

### 解析云端 portable target

当状态为 `unbound_portable_target` 时，向导显示云端 portable label，并允许用户：

1. 将该 label 显式绑定到一个已有的设备本地 target；
2. 进入 RFC-0002 的 target 配置向导创建新 target，验证后再建立 binding；
3. 只读打开，暂不建立 binding。

binding 是设备本地映射，不修改云端 Session Location revision，也不要求本地 target 与其他设备使用相同 ID 或名称。一个 binding 可以恢复本设备上引用同一 portable label 的多个 Session；提交前必须向用户展示影响范围。名称相同只能作为候选提示，绝不能自动确认 binding。

## 空闲条件

只有满足全部条件时才可开始提交：

- 没有运行或排队的 Agent turn；
- 没有进行中的 tool/process/User Shell execution 或待处理 permission/question；
- 没有活跃 Terminal PTY，包括停在交互 Shell prompt 的 PTY；
- 没有正在提交的 Session mutation、Location rebind 或同步回放事务。

不满足时拒绝操作并列出阻塞项。v1 不提供“自动取消任务并迁移”或“关闭 Terminal 后继续”；用户必须先自行处理，再重新发起。

## 实验性重绑定流程

1. 用户在 `/sessions` 或 unresolved 恢复向导中选择 `Force rebind location...`。
2. UI 展示旧 Location、对话与工作区可能不一致的风险，并要求确认。
3. 用户选择 `local` 或一个已配置 target，再选择对应机器上的绝对目录。
4. Core workflow 暂存并验证新 Location。
5. 提交前再次检查 Session 空闲和 Location revision。
6. 原子更新 Session Location，重建 Location-scoped runtime。
7. 返回 Session，并展示已从旧 Location 切换到新 Location 的本地控制面通知；不创建对话消息。

如果新 target 或目录与旧 Location 完全相同，操作返回 unchanged，不增加 revision，也不重建 runtime。

强制 rebind 的 mutation scope 永远是请求中的单个 `sessionID`。它不得修改 target definition、portable label binding 或其他引用旧/新 target 的 Session，也不得以“同一 target”为条件向一批 Session 广播 Location 变更。RFC-0010 启用时，只同步这个 Session 自己的新 Location revision。

## Domain transaction

客户端只调用类型化 domain workflow：

```text
SessionLocationRebind {
  sessionID
  expectedRevision
  destination: LocationRef
}
```

执行顺序固定为：

```text
获取 Session location mutation lock
  -> 检查 expectedRevision 与完全空闲状态
  -> 解析 target ID
  -> 建立或准备候选 Location services
  -> 校验 SSH/Rexd handshake、capabilities 与 workspace roots
  -> 校验 directory 并预加载 RFC-0005 EnvironmentSnapshot
  -> 原子提交 LocationRebound event 与新 revision
  -> 使旧 Location runtime 失效并释放资源
  -> 发布 location changed domain event
```

local destination 不执行 SSH/Rexd 步骤，但必须进行相同的目录和环境校验。Session Location 的事实来源只能在 domain transaction 中更新，TUI、同步 adapter 和工具不能直接修改数据库字段。

提交前任何步骤失败时，保留旧 Location、revision 和 runtime。提交后旧资源清理失败不能回滚已经生效的新 Location；应报告 cleanup warning 并继续尽力释放，避免回滚导致已开始的新位置操作落到旧位置。

## Runtime 重建

提交成功后必须：

- 失效旧 Location connection lease、services 和 capability cache；
- 清除 RFC-0004 User Shell runtime cwd，使下一条命令从新 Session Location directory 开始；
- 丢弃 completion generation 和候选缓存；
- 使用预加载的新 Location 环境发布新的 RFC-0005 generation；
- 刷新文件、搜索、process、PTY、LSP、formatter 和 task 的 Location-scoped provider；
- 保留 Session messages、parts、模型选择、标题、父子关系和其他对话 metadata。

重绑定不会自动 compact、清空或向 Agent 解释历史。UI 在下一次提交前持续显示 Location changed 提示，直到用户提交 prompt 或主动关闭提示。

## 同步语义

同步关闭时，rebind 只修改当前设备上的该 Session Location。RFC-0010 启用时，domain event 还为该 Session 产生新的可移植 Location revision：

```text
PortableSessionLocation {
  revision
  target: local-owner | label(portableTargetLabel)
  directory
  updatedByDeviceID
}
```

云端不保存设备本地 target ID 或连接详情。其他设备收到 revision 后，通过自己的显式 label binding 解析 target；没有 binding 时保持 Session 可查看但 Location unresolved。并发 Location revisions 由 RFC-0010 的确定性冲突规则收敛，不能按到达顺序静默覆盖。

RFC-0010 的“未归属 Session”只表示没有 `syncSpaceID`，与本 RFC 的 Location `unresolved` 是两个正交状态。全局删除 space 或从本设备完整移除同步时，清除 sync ownership 不得清除 Location、target binding 或本地 target definition；Session 随后仍按原 Location 独立解析。同步设置中的批量归属提示也只改变 sync ownership，不能替代、触发或绕过 unresolved target 恢复向导。

## 与其他 RFC 的关系

- RFC-0002 继续规定 target、Location provider、验证和连接生命周期。
- RFC-0004 规定被清除的 User Shell cwd runtime state。
- RFC-0005 规定候选环境预加载和新 generation。
- RFC-0006 只提供 `/sessions` UI 入口，不实现 transaction。
- RFC-0010 只观察正式 Location domain event，不直接写 Session Location。

## 非目标

- 迁移运行中的 Agent、process 或 PTY；
- 同步或复制两个工作区的文件；
- 校验新工作区内容与历史工具输出相同；
- 自动选择同名 target 或目录；
- 提供负载均衡、故障转移或透明本地回退。

## 验收条件

1. unresolved 恢复入口始终可用；实验开关默认关闭，关闭时只隐藏 rebind，不隐藏只读打开、重试、编辑、恢复缺失配置或 portable label binding。
2. 各类 unresolved 原因、warning、确认、取消、draft 保留和 unchanged 行为有 UI 测试。
3. Agent、tool、User Shell、permission/question、PTY、mutation 和 sync replay 任一活跃时均拒绝 rebind。
4. local 与 Rexd destination 共用 transaction contract；连接、握手、roots、目录和环境失败均保持旧 Location。
5. expected revision 在最终提交前重新检查，并发修改不能被覆盖。
6. 成功后 User Shell cwd、completion、environment、lease 和全部 Location services 切换到新位置，历史 Session 内容保持不变。
7. cleanup failure 不回滚已提交 Location，并产生可诊断 warning。
8. 同步开启时只发送 portable label/directory/revision，不发送 target ID、SSH 配置或凭据。
9. 未绑定 portable label 的设备保持 unresolved，不自动使用 local 或同名 target。
10. 恢复被移除 target 的原 ID 和建立 portable label binding 都不产生 Location revision，并且在恢复执行前完成完整 Location 验证。
11. 恢复向导在影响多个 Session 时展示影响范围；普通 target CRUD 不能任意复用缺失 ID。
12. registry 级恢复可以批量恢复同一缺失 target ID 的 Session；强制 rebind 只修改一个 Session，不修改 registry/binding 或其他 Session，同步开启时也只发布该 Session 的 Location revision。
