---
id: 0009
title: Experimental Session Location Rebinding
status: accepted
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-06
implemented-by: []
depends-on:
  - 0001
  - 0002
  - 0004
  - 0005
supersedes: []
superseded-by: []
---

# RFC-0009：实验性 Session Location 强制重绑定

## 摘要

允许用户从 `/sessions` 管理界面把一个既有 Session 强制重绑定到新的 local 或 Rexd target 与工作目录。该能力默认隐藏、明确标注为不推荐，并只允许对完全空闲的 Session 执行。

重绑定保留对话历史，但更换后续工具和 Shell 所看到的工作环境。它不是 RFC-0002 QuickStart 新建 Session 主流程的一部分，也不提供通用 `/target` 中途切换命令。

## 动机与风险

同步或设备变化后，Session 原 Location 可能无法恢复；用户也可能有意在另一机器或目录继续同一段对话。直接修改 Location 有明显风险：历史工具输出、文件路径和 Agent 对代码状态的理解可能不再对应新工作区。

因此本功能必须是显式的恢复/高级管理操作，不能在 target 缺失、连接失败或目录失效时自动触发，也不能静默回退到 local。

## 入口与开关

- 设备级用户实验设置控制 `Force rebind location...` 是否出现在 `/sessions` 的 Session 管理 actions 中；默认关闭。
- action 必须标注 `Experimental` 和 `Not recommended`，不能放成列表中的普通确认快捷键。
- 进入流程时保留客户端尚未提交的 prompt draft；取消和失败不能修改 draft。
- 允许从当前、历史或 unresolved Session 发起；旧 Location 不可连接不影响选择新 Location。
- v1 不注册 `/target` 形式的中途切换命令。

## 空闲条件

只有满足全部条件时才可开始提交：

- 没有运行或排队的 Agent turn；
- 没有进行中的 tool/process/User Shell execution 或待处理 permission/question；
- 没有活跃 Terminal PTY，包括停在交互 Shell prompt 的 PTY；
- 没有正在提交的 Session mutation、Location rebind 或同步回放事务。

不满足时拒绝操作并列出阻塞项。v1 不提供“自动取消任务并迁移”或“关闭 Terminal 后继续”；用户必须先自行处理，再重新发起。

## 用户流程

1. 用户在 `/sessions` 中选择 `Force rebind location...`。
2. UI 展示旧 Location、对话与工作区可能不一致的风险，并要求确认。
3. 用户选择 `local` 或一个已配置 target，再选择对应机器上的绝对目录。
4. Core workflow 暂存并验证新 Location。
5. 提交前再次检查 Session 空闲和 Location revision。
6. 原子更新 Session Location，重建 Location-scoped runtime。
7. 返回 Session，并展示已从旧 Location 切换到新 Location 的本地控制面通知；不创建对话消息。

如果新 target 或目录与旧 Location 完全相同，操作返回 unchanged，不增加 revision，也不重建 runtime。

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

同步关闭时，rebind 只修改当前设备的 Session Location。RFC-0010 启用时，domain event 还产生新的可移植 Location revision：

```text
PortableSessionLocation {
  revision
  target: local-owner | label(portableTargetLabel)
  directory
  updatedByDeviceID
}
```

云端不保存设备本地 target ID 或连接详情。其他设备收到 revision 后，通过自己的显式 label binding 解析 target；没有 binding 时保持 Session 可查看但 Location unresolved。并发 Location revisions 由 RFC-0010 的确定性冲突规则收敛，不能按到达顺序静默覆盖。

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

1. 实验开关默认关闭，关闭时 `/sessions` 不显示入口。
2. warning、确认、取消、draft 保留和 unchanged 行为有 UI 测试。
3. Agent、tool、User Shell、permission/question、PTY、mutation 和 sync replay 任一活跃时均拒绝 rebind。
4. local 与 Rexd destination 共用 transaction contract；连接、握手、roots、目录和环境失败均保持旧 Location。
5. expected revision 在最终提交前重新检查，并发修改不能被覆盖。
6. 成功后 User Shell cwd、completion、environment、lease 和全部 Location services 切换到新位置，历史 Session 内容保持不变。
7. cleanup failure 不回滚已提交 Location，并产生可诊断 warning。
8. 同步开启时只发送 portable label/directory/revision，不发送 target ID、SSH 配置或凭据。
9. 未绑定 portable label 的设备保持 unresolved，不自动使用 local 或同名 target。

