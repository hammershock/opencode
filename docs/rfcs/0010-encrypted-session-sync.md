---
id: 0010
title: Account-wide Multi-device Session Sync
status: accepted
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-08
implemented-by:
  - https://github.com/hammershock/opencode/pull/195
depends-on:
  - 0002
  - 0003
supersedes: []
superseded-by: []
---

# RFC-0010：账户级多设备 Session 同步

## 摘要

OpenCode Core 提供 provider-neutral 的多设备 Session 同步能力，v1 storage provider 为百度网盘。产品模型只有一层：用户连接百度账号并开启同步后，该账号下的 OpenCode 同步目录自动上行、下行所有 Session；用户不创建、加入、切换或理解 sync space。

同步只覆盖完整 Session 事件、标题、关系、可移植 Location metadata 和 Session 内持久化附件。它不覆盖 OpenCode 配置、target、workspace 文件、环境变量、provider credential 或 UI 状态。v1 不提供应用层端到端加密。

同步采用 durable transactional outbox、按设备追加的不可变事件段、per-device head/checkpoint、幂等消费、删除 tombstone 和确定性冲突处理。自动同步关闭只停止队列消费，不丢弃或绕过本地产生的同步事件。

## 产品模型

用户只需要理解四个概念：

1. `Baidu Netdisk`：当前连接的百度账号；
2. `Automatic sync`：是否在后台消费同步队列；
3. `Devices`：已经接入这套账号同步数据的设备；
4. `Cloud data`：该账号下 OpenCode Session 同步目录的状态和破坏性清理入口。

以下概念不得出现在 v1 用户界面、slash command 描述或错误提示中：

- sync space、active space、join、leave、switch；
- Session assignment、unassigned Session；
- encryption mode、recovery key。

Core 可以使用固定的内部 scope key 分区本地同步表，但它不是用户身份、可选择空间或公开协议字段。

## 目标

1. 本设备创建或继续的 Session 在同步后可由另一设备打开并继续工作；
2. 一旦同步目录初始化，全部既有和未来 Session 自动参与同步，不要求逐 Session 归属确认；
3. 本地 Session 提交与 outbox 写入具有一致的恢复边界，离线和关闭自动同步不会丢事件；
4. Session 删除立即成为全设备逻辑删除，旧事件、旧 outbox、缓存、重启和迟到设备均不能在删除收敛前复活它；
5. 所有引用该 Session 的有效设备确认删除后，云端 Session payload、附件、tombstone 和 acknowledgement 最终全部回收；
6. 百度网盘失败、离线或限流不阻塞本地 Session 使用；
7. 用户可以彻底重置百度网盘上的 OpenCode 同步目录，而不删除本地 Session。

## 非目标

- 同步 workspace 普通文件、Git checkout、OpenCode 配置、target registry、SSH 配置或 `.env`；
- 多账号同时同步、选择性 Session 同步、共享空间或团队空间；
- Web/Desktop 同步设置 UI；
- 应用层端到端加密或 recovery key；
- 把百度网盘当作通用消息队列或提供任意远程文件同步。

## Domain ownership 与本地状态

OpenCode EventV2 Session 数据库是本地事实源。同步层观察正式 domain event，通过 capture journal 原子或可恢复地写入 durable outbox，并通过同一个 Session projector 回放远端事件；不得覆盖整个数据库文件。

```text
Session transaction / durable event
  -> capture journal
  -> durable outbox
  -> per-device immutable segment
  -> Baidu provider
  -> remote head/checkpoint
  -> pull, verify, idempotent apply
  -> Session projector
```

本地同步状态位于解析后的 OpenCode 用户配置目录：

```text
<OpenCode user config directory>/sync/config.json
<OpenCode user config directory>/sync/state.json
<OpenCode user config directory>/sync/sync.db
```

`config.json` 只保存 provider、本设备 ID/name、已连接账户摘要、automatic sync、interval 和远端是否已经在本机确认初始化。`sync.db` 使用 WAL，保存 outbox、cursor、segment cache、lease、deletion marker 和 acknowledgement。OAuth credential 只进入系统安全存储。

同步目录初始化后，启动恢复扫描全部仍存在的 Session，补齐 capture/ownership；新 Session 创建时自动进入固定内部同步 scope。automatic sync 关闭、网络离线或账号暂时退出时，事件继续进入 outbox 并积压。

## 百度 OAuth 与登录钩子

百度 v1 使用 OpenCode 产品注册的 OAuth client。TUI 提供产品自有的 OAuth 流程，普通用户不填写 AppKey、SecretKey，不粘贴 access token，也不读取百度客户端、浏览器、CLI 或其他应用的登录态。

macOS credential 存入 Keychain，WSL credential 存入宿主 Windows PasswordVault。运行时可以做进程内 credential read cache/coalescing，避免同一进程反复触发安全存储访问；不得回退明文文件。

OAuth 成功后 automatic sync 必须为关闭状态，并显示一次选择：

```text
Enable and sync now | Enable | Keep disabled
```

- `Enable and sync now`：开启 automatic sync，然后进入一次手动同步流程；
- `Enable`：开启 automatic sync，不把 OAuth 完成阻塞在首次传输上；
- `Keep disabled`：保持关闭。

退出百度账号时：

1. 停止 scheduler；
2. automatic sync 设为关闭；
3. 清除本设备 OAuth pending state 和百度 credential；
4. 保留本地 Session、outbox、cursor 和设备 ID，以便以后重新授权恢复。

## 云端初始化哨兵

百度账号下使用一个固定 OpenCode Session 同步目录。目录中的 `manifest.json` 是唯一初始化事实：

```text
/apps/opencode-sync/session-sync/
  manifest.json
  devices/<deviceID>.head.json
  segments/<deviceID>/<generation>.json
  deletions/<sessionID>/marker.json
  deletions/<sessionID>/acks/<deviceID>.json
  chunks/...
```

没有有效 manifest 时，其余对象全部视为未提交的孤儿数据，不能读取、投影或作为“已经初始化”的证据。

手动同步和 automatic sync 每次开始前都检查 manifest：

- manifest 有效：开始同步；
- manifest 缺失：请求用户选择 `Initialize and sync` 或 `Cancel`；
- automatic sync 的初始化请求被取消时，同时关闭 automatic sync；
- manifest 版本不兼容：停止，不得覆盖，并显示兼容性诊断。

初始化流程先清理 manifest 缺失状态下的孤儿同步对象，再以 absent precondition 发布一个有效的空目录 manifest。manifest 是目录初始化的提交点；本设备 head、既有 Session 回填和首次传输随后通过 durable outbox 完成，即使中途退出也可以继续。manifest 发布前不得上传或读取 Session 数据。

后台 scheduler 本身不能直接控制 TUI。它通过类型化的 `initialization-required` 状态/事件请求前台决策；没有活动前台时暂停消费队列，不反复上传或静默初始化。

## 队列、幂等与 checkpoint

“消息队列”是同步语义，不要求百度网盘提供 queue service。实现采用本地 transactional outbox 和云端追加对象：

- 本地 Session 事件与 capture journal 处于同一可恢复事务边界；
- outbox 采用至少一次投递，operation ID 全局稳定；
- consumer 必须记录 operation ID/fingerprint，重复下载和重试不得产生重复副作用；
- 同一设备按递增 generation 发布不可变 segment 和 head；
- 每台设备在 head 中发布自己已经完整应用的其他设备 generation；
- cursor 只有在对象校验、事件回放和 Session projection 全部提交后推进；
- automatic sync 关闭只停止 scheduler，不能清空、跳过或改写 outbox；
- 恢复联网、手动同步和重新开启 automatic sync 从 checkpoint 继续。

百度 provider 只提供 list/stat/download/atomic upload/delete 等对象操作；Core 不在百度文件上实现易受重试影响的裸整数 `+1/-1`。

## Session 删除与引用回收

Session 删除采用 remove-wins 语义。删除操作本地立即删除 Session projection，并把 durable tombstone 写入原子恢复链路。同步时先吸收远端删除，再允许上传本地旧事件。

逻辑上的“引用”是稳定设备 ID 的集合，不是直接修改的整数：

```text
required = 删除发生时已声明持有该 Session 的有效设备集合
acked    = 已成功应用删除的 required 设备集合
references = required - acked - revoked
referenceCount = size(references)
```

`referenceCount` 只用于展示和 GC 判断。ack 使用 `(tombstoneID, deviceID)` 唯一键，重复提交幂等；设备撤销是单调事实，等价于该设备不再阻塞回收。

删除流程：

1. 删除设备本地彻底删除 Session，并写入 tombstone/outbox；
2. 首次发布 tombstone 前先拉取最新有效 device heads，冻结 `required` 集合；
3. 云端立即将 Session 标记为 deleted，正常索引不再展示它；
4. 其他设备拉取 tombstone，先持久化本地删除事实，再删除 Session projection 和未发送的旧 outbox；
5. 该设备先原子发布不再包含此 Session 的新 head，成功后才发布幂等 ack；head 提交前进程中断时仍保留引用；
6. `references` 非空时保留仍可能被离线设备读取到的 payload 和 tombstone；
7. `references` 为空时，删除该 Session 的云端 payload、附件、marker 和 ack 对象；
8. 回收属于后台优化，不得影响删除的逻辑正确性；回收失败进入可重试诊断。

为使 payload 可按 Session 回收，新协议不得把多个 Session 的不可分割正文永久混合在同一 GC 单元。segment 可以批量传输，但远端索引必须能确定性重写或删除某个 Session 的全部 payload，而不删除其他活动 Session。

被撤销或退出同步设备不再阻塞新的 GC。设备以后重新登录时必须先 pull、应用当前云端状态，再允许 push；不能用旧本地队列抢先覆盖云端。

## 冲突与 Location

同一 aggregate/seq 的 event ID、type 和 canonical payload 完全相同才是重复。发生真正分叉时，使用稳定的 device/event 顺序选 winner，loser 从首次冲突点物化为确定性的 sibling Session。删除始终胜过同一 Session 的旧事件。

云端 Location 只保存 owner device、portable target label、directory、revision 和 updater，不保存设备本地 target ID、连接配置或 credential。另一设备缺少相应 target 时，Session 只读打开并按 RFC-0009 配置或重绑定。

## 设备管理

`/devices` 深链到 `/sync` 的 Devices 子视图。设备记录包含稳定 ID、用户可编辑名称、last seen、current/revoked 状态和删除确认进度。

- 当前设备不能从远端 revoke 自己；退出账号走 logout；
- revoke 是单调操作，旧 head 不能恢复设备；
- revoke 不远程擦除设备本地数据，但使其 credential/session state 在下次连接时必须重新接入；
- 不按离线时长自动 revoke，废弃设备由用户显式移除。

## 清除云端同步数据

`Clear cloud sync data` 是账户范围的破坏性操作：

1. 第一次确认说明所有云端 Session 历史将被删除；
2. 第二次确认只提供 `Cancel` 与红色 `Clear cloud sync data`；
3. 执行时先删除或使 manifest 失效；
4. 再清理该固定同步目录中的 heads、segments、Session payload、attachments、tombstones、acks 和孤儿对象；
5. 最后关闭本设备 automatic sync；
6. 本地 Session 保留。

云端重置不保留 reset generation/epoch（per-device segment generation 仍是正常 checkpoint 的组成部分）。其他设备发现 manifest 缺失后必须暂停，不得自动重建；前台让用户选择 `Initialize and sync` 或暂时不处理。用户明确重新初始化意味着允许当前设备的本地 Session 建立一套新的云端数据。

清理与其他设备在途上传并发时，manifest 缺失仍然具有最高优先级：在途产生的对象是不可见孤儿，下次初始化会先清理它们，不能让它们恢复同步目录。

## 调度和触发

automatic sync 提供 30 秒、1 分钟、5 分钟 interval，默认 30 秒。以下动作触发同步尝试：

- 用户执行 `Sync now`；
- scheduler 到期；
- 网络恢复；
- 应用启动且 automatic sync 已开启。

相同方向的并发请求合并。provider 失败使用有上限的指数退避和抖动。只有发生有效远端操作时才显示右上角状态栏；传输完成立即消失，失败保留 stage、operation、稳定 kind、retryability 和脱敏原因。

## TUI

`/sync`、command palette 的 `Sync settings` 和 QuickStart 入口打开同一 workflow：

```text
Baidu Netdisk       Connected / Disconnected
Automatic sync     On / Off
Sync now
Interval           30 sec / 1 min / 5 min
Devices
Cloud status
Clear cloud sync data
Log out
```

未连接时只显示连接流程。未初始化时 `Cloud status` 显示 `Not initialized`。面板打开和编辑本地设置不能等待百度请求；Cloud status、Sync now、Devices 和破坏性操作按需访问远端，并接入共享状态栏。

`/devices` 与上述 Devices 子视图等价。所有 Sync command 都是 RFC-0003 control-plane command，不进入 Session 或模型上下文。

`/sessions` 默认展示本机 Session 和已索引的云端 metadata；同步不再提供 `Current Sync Space` scope。Target + Location 继续按 RFC-0009 展示。

## 安全与凭据边界

- 只使用 OpenCode 产品 OAuth credential；
- 不读取浏览器、百度客户端、外部 CLI 或旧应用登录态；
- 日志、状态栏、Session 和模型上下文不得包含 token、authorization code、client secret、Keychain 内容或私有下载 URL；
- 清除云端数据必须使用 provider 精确根路径，不能接受用户输入路径、通配符或未解析变量；
- provider mutation 使用 precondition/idempotency identity，重试不能重复计数或破坏已提交状态。

## 成熟设计依据

本协议不复制某个完整数据库，而采用以下成熟机制的交集：

- AWS Transactional Outbox：业务提交与 outbox 原子化，至少一次投递要求 consumer 幂等；
- Apache CouchDB replication：changes feed、per-replica checkpoint、删除 revision 和 purge sequence；
- Apache CouchDB clustered purge：只有相关 replication/index checkpoint 越过 purge sequence才回收 purge history；
- Syncthing：per-device version/head 和 global desired state，而不是共享裸引用计数；
- CRDT causal stability：tombstone GC 需要确认所有相关副本已经观察删除，GC 不处于正常写入关键路径。

参考：

- https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html
- https://docs.couchdb.org/en/stable/replication/intro.html
- https://docs.couchdb.org/en/stable/cluster/purging.html
- https://docs.syncthing.net/users/syncing.html

## 验收条件

1. 产品界面没有 sync space、assignment、encryption 或 recovery key；
2. OAuth 完成后 automatic sync 默认关闭，并出现规定的三个选择；
3. manifest 缺失时，手动和自动同步均不上传；初始化只能由用户明确确认；
4. 初始化后所有既有和未来 Session 自动进入同步范围；关闭 automatic sync 时 outbox 正常积压；
5. Mac 创建 Session 后可由 mywindows 拉取、打开并继续，反向同样成立；
6. Session 删除优先于迟到事件；ack 重试幂等且只能在设备新 head 提交后发布；只有全部 required device ack/revoke 后才 GC；
7. GC 后该 Session payload、附件、tombstone 和 ack 不再存在于百度同步目录；
8. cloud reset 先使 manifest 失效，彻底清理固定同步目录，关闭本设备 automatic sync，并保留本地 Session；
9. reset 后其他设备只能由用户确认重新初始化，不能后台静默复活数据；
10. logout 关闭 automatic sync、清除 OpenCode 百度 credential，并保留本地 Session/outbox；
11. provider 超时、限流、断网、重复响应和未知提交结果通过幂等重试收敛；
12. `/sync`、`/devices`、QuickStart 和 command palette 使用同一个状态机；
13. 所有远端等待进入共享右上角状态栏，失败提供脱敏的阶段和原因；
14. 不同步 workspace 文件、target/SSH 配置、`.env`、provider credential 或 UI state；
15. Mac 与 mywindows 使用同一 commit 的 `opencode-rexd` 完成双向真实验收。
