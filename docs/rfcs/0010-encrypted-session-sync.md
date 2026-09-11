---
id: 0010
title: Account-wide Multi-device Session Sync
status: accepted
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-11
implemented-by:
  - https://github.com/hammershock/opencode-transit/pull/195
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

本 RFC 冻结 Session sync 的 v1 contract。后续 [RFC-0012](0012-skill-catalog-and-invocation.md) 复用同一账户和同步基础设施，增加需要单独 opt in、且只覆盖 OpenCode global `skill/` 与 `skills/` package 的 Skill sync；它不改变本 RFC 对配置、target、workspace 与任意目录同步的排除。

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

`config.json` 只保存 provider、本设备 ID/name、已连接账户摘要、automatic sync、interval 和远端是否已经在本机确认初始化。每次云端初始化生成一个不暴露给用户的随机 instance ID；它同时隔离远端对象前缀和本地 `sync.db` scope。`sync.db` 使用 WAL，保存 outbox、cursor、segment cache、lease、deletion marker 和 acknowledgement。百度 AppKey、SecretKey 与 OAuth credential 只进入 OpenCode 的 `Auth.Service`，不得复制到 sync 配置或数据库。

同步目录初始化后，启动恢复扫描全部仍存在的 Session，补齐 capture/ownership；新 Session 创建时自动进入固定内部同步 scope。automatic sync 关闭、网络离线或账号暂时退出时，事件继续进入 outbox 并积压。

## 百度 OAuth 与登录钩子

百度 v1 使用用户自己在百度开放平台创建的应用。首次连接时，TUI 请求 AppKey 与 SecretKey，然后启动产品内 OAuth 流程；用户不粘贴 access token，也不读取百度客户端、浏览器、CLI 或其他应用的登录态。OpenCode Transit 不内置共享 client secret，也不依赖产品托管的 token exchange 后端。

百度 credential 与 model provider credential 使用同一个 OpenCode `Auth.Service` 和 `<OpenCode data directory>/auth.json`。保留 key `opencode-transit/baidu` 对应一条 OAuth credential：access token、refresh token、expiry 和 account ID 使用 OAuth 标准字段，AppKey 与 SecretKey 使用 OAuth metadata 字段。`auth.json` 必须保持 `0600`；运行时可以做进程内 credential read cache/coalescing，且所有诊断必须脱敏。

升级时不得静默把 Keychain 或 PasswordVault credential 降级到文件。只有用户在连接流程中确认迁移后，客户端才读取旧记录、写入并验证 `Auth.Service` 条目。验证失败保留旧记录并报告可恢复错误；验证成功也默认保留旧记录，只有用户明确选择清理时才删除。生产流程不扫描或导入其他应用、浏览器、CLI 或任意 secure-store identity。

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
3. 清除本设备 OAuth pending state 和 `opencode-transit/baidu` credential；
4. 保留本地 Session、outbox、cursor 和设备 ID，以便以后重新授权恢复。

## 云端实例与初始化哨兵

百度账号下使用一个固定 OpenCode Session 同步目录，但每次初始化的数据位于独立实例前缀。`control/current-v2.json` 是当前实例的控制事实：

```text
/apps/opencode-sync/session-sync/
  control/current-v2.json
  instances/<instanceID>/instance.json
  instances/<instanceID>/control/v2/log/<generation>.json
  instances/<instanceID>/devices/...
  instances/<instanceID>/segments/...
  instances/<instanceID>/deletions/...
  instances/<instanceID>/chunks/...
```

控制文件没有正向指向本机绑定的 instance 时，其余对象全部视为旧实例或未提交孤儿，不能读取、投影或作为“已经初始化”的证据。一次 list/stat 负向结果不足以证明 reset；本机已绑定实例只有在精确读到有效 reset record 或不同 instance ID 后，才确认云端已重置。

手动同步和 automatic sync 每次开始前都检查 manifest：

- control 有效且 instance ID 匹配：开始同步；
- control 未初始化或正向指向其他 instance：暂停并请求用户选择 `Initialize and sync` 或 `Cancel`；
- automatic sync 的初始化请求被取消时，同时关闭 automatic sync；
- manifest 版本不兼容：停止，不得覆盖，并显示兼容性诊断。

初始化流程先创建随机 instance 的不可变 descriptor，再发布并精确回读 current control。只有回读仍指向该 instance 的 writer 才能绑定本地 scope；并发 loser 必须停止。current control 是逻辑初始化提交点；本设备 head、既有 Session 回填和首次传输随后通过 durable outbox 完成。绑定本地 scope 与跨数据库的 Session membership/backfill 之间必须有 durable bootstrap marker：任何中断后的启动、automatic worker 或手动同步都先幂等完成 bootstrap，不能留下“已经加入 v2 但本地 Session 永不上云”的半完成状态。旧实例的迟到写只能成为隔离 orphan，不能进入新实例。

历史 `account-v1` 原型不属于公开兼容协议，也不能在后台静默改写为 v2。升级构建必须将它显示为 `upgrade required` 并停止写入；本项目首次部署按已确认的覆盖策略，先分别备份两台设备的本地数据库，再显式 reset/初始化 v2，并让两端依次加入、回填各自仍存在的本地 Session。不得因为一次云端缺失观察自动清理 v1，亦不得把 v1 deletion archive 当作 v2 删除事实。

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

百度 provider 只提供 list、精确 stat/download、不覆盖创建、可变 hint 替换和尽力删除。百度没有通用事务或 version-CAS；Core 不得以 `stat -> rtype=3 create` 或 `stat -> delete` 的检查间隙建立正确性，也不在百度文件上实现易受重试影响的裸整数 `+1/-1`。

每个本地变更的提交顺序固定为：

```text
local durable event/control outbox
  -> append and exact-read immutable control fact when applicable
  -> seal immutable segment
  -> upload and verify immutable segment
  -> publish monotonic device head exposing that generation
  -> publish immutable deletion head-fence and acknowledgement when applicable
  -> acknowledge the local segment and clear its outbox rows
```

`seal` 不清除 outbox。segment 已存在时必须下载并验证 canonical payload；head 或 deletion acknowledgement 失败时，本地 segment 继续保持 pending，下一 worker 验证并复用同一路径后重试。只有没有 pending segment 的旧进程可以在发现远端同设备 head 更高时无副作用退出；它不能回退 head 或替自己未发布的删除状态确认。

per-device 可变 head 只能作为发现加速 hint，不是 durable event log 或删除正确性事实。generation 单调递增；同 generation 的 `acknowledged` 按设备取最大 cursor，`revoked` 取集合并集。Session 正文只存在于不可变 segment/attachment。正确性所需的 control entry、head revision 和 deletion acknowledgement 使用固定路径、不覆盖创建并精确校验；ack 引用的 fence 必须携带并验证完整 canonical head checkpoint，不能只信任调用方提供的 digest。checkpoint 与待提交 ack 先在本地同一事务中持久化，进程崩溃后复用同一 revision 与字节；未知提交结果必须通过 canonical path stat/download 验证。

## 百度 provider 一致性边界

百度网盘在本协议中是文件系统式传输层，不是数据库、消息队列、事务对象存储或 changes feed。`rtype=3` 替换 mutable head 后，目录 list、path metadata、dlink 和内容下载可能在短暂窗口内观察到不同代；单次 list 也可能暂时遗漏仍存在的路径。

因此以下负向观察都不具有删除语义：

- 一次 list 没有返回已知 device head；
- canonical path stat 暂时返回 not found；
- 已取得 metadata/dlink 后正文暂时返回 HTTP 404；
- immutable segment 在 head 已更新后暂时不可读。

只有 Session tombstone、device revoke 和 manifest 缺失/失效分别具有 Session、设备和账户同步目录的单调删除语义。缓存只能在观察到对应单调事实后清除；不得根据一次 list/stat/download 缺失执行 metadata retain、删除 Session 或推进 cursor。

mutable head 使用官方 path metadata 查询精确路径的当前 `fs_id`、mtime、size 和 dlink，而不是依赖父目录 list 中的旧 `fs_id`。多个已知设备 head 使用 `filemetas` 的 path 数组批量精确探测，结果按请求 path 映射；缺失只表示本轮没有可读对象。pinned version 不一致返回 conflict；dlink/content 的短暂 404 重新取得整套 path metadata 后做短时有界重试。第一次见到但暂不可读的 head 本轮可以跳过；已有 head 必须保留上次成功快照；两者都不能缓存未成功解码的新版本。immutable segment 缺失不能吞掉：cursor 保持落后，使相同 head 在后续 probe 中继续触发 hydrate。

百度目录 list 只用于发现候选变化，不是完整成员快照或删除日志。权威设备成员与 Session 删除写入按 generation 串行、可回放的不可变 control log；删除条目的 `requiredDevices` 等于它之前一代 control state 的有效设备集合。删除之后加入的设备必须先回放 control log，不能先上传本地旧队列。云端 payload GC 后，各设备仍保留紧凑的本地 remove-wins tombstone。

## Session 删除与引用回收

Session 删除采用 remove-wins 语义。删除操作先把稳定 operation ID 和 tombstone 写入 durable control outbox，再立即删除本地 Session projection。若进程在二者之间中断，重启后的 control projection 会幂等完成删除。同步时必须先回放并投影远端 control delete，再允许上传本地旧事件。

逻辑上的“引用”是稳定设备 ID 的集合，不是直接修改的整数：

```text
required = canonical session.delete 前一代 control state 的有效设备集合
acked    = 已应用删除并发布 immutable head-fence 的 required 设备集合
references = required - acked - revoked
referenceCount = size(references)
```

`referenceCount` 只用于展示和 GC 判断。最早进入 control log 的 `session.delete` 是该 Session 的 canonical 删除；并发或迟到的其他 tombstone 归并为 alias，不能扩大 required 集合或重新启动一轮 GC。ack 使用 `(canonicalTombstoneID, deviceID)` 唯一键，包含 delete control generation 与 immutable head-fence digest；重复提交幂等。设备撤销是单调 control fact，等价于该设备不再阻塞回收。

删除流程：

1. 删除设备先写入 control intent，再在本地彻底删除 Session 并写入 tombstone/event outbox；
2. intent 抢占不可变 control generation 时，以它之前一代的权威 membership 冻结 `required`；并发 join/revoke 抢先时 deletion intent 必须 rebase 并重新计算 fence；
3. 云端立即将 Session 标记为 deleted，正常索引不再展示它；
4. 其他设备严格按 control generation 回放；验证链后先持久化本地删除事实，再删除 Session projection 和未发送的旧 outbox；control ingest cursor 与 Session projection cursor 分开持久化；
5. 如果被删除的 Session 正在任一 TUI 中打开，该 TUI 必须显示删除提示；用户确认后返回 QuickStart，不得继续停留在失效会话；
6. 该设备先发布不再包含此 Session 的 mutable head，再以不覆盖路径发布包含 delete generation、event generation、control generation 和 metadata digest 的 immutable head-fence，最后发布引用该 fence 的幂等 ack；任一步中断时仍保留引用；
7. `references` 非空时保留仍可能被离线设备读取到的 payload 和 tombstone；
8. `references` 为空时，collector 精确读取并校验每个 required device 的 ack 与 fence，再追加不可变 `session.gc` control entry；GC entry 是允许物理回收的提交点；
9. 回收属于后台优化，不得影响删除的逻辑正确性；回收失败进入可重试诊断。

为使 payload 可按 Session 回收，新协议不得把多个 Session 的不可分割正文永久混合在同一 GC 单元。现有混合 segment 在迁移完成前保持不可变，collector 严禁通过 `rtype=3` 原地重写；此阶段 `session.gc` 先完成逻辑回收，紧凑 tombstone/control fact 继续阻止复活。彻底正文回收以 per-Session payload 格式落地为前提；只有 Session 专属 payload、附件、ack 与 fence 可以安全物理删除。

被撤销或退出同步设备不再阻塞新的 GC。设备以后重新登录时必须先 pull、应用当前云端状态，再允许 push；不能用旧本地队列抢先覆盖云端。

## 冲突与 Location

同一 aggregate/seq 的 event ID、type 和 canonical payload 完全相同才是重复。发生真正分叉时，使用稳定的 device/event 顺序选 winner，loser 从首次冲突点物化为确定性的 sibling Session。删除始终胜过同一 Session 的旧事件。

云端 Location 只保存 owner device、portable target label、directory、revision 和 updater，不保存设备本地 target ID、连接配置或 credential。Rexd Session 使用当时记录的 target name；源设备本地执行的 Session 使用该设备稳定的 `deviceName` 作为 portable target label。源设备仍将自己的本地 Session 显示为 `local`，其他设备将该 label（例如 `mymac`）视为非本机 target；缺少相应配置或绑定时，Session 只读打开并按 RFC-0009 配置或重绑定，不能按名称自动绑定。

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
3. 执行时先发布并精确验证 reset control record，使旧 instance 立即逻辑失效；
4. 再尽力清理旧 instance 中的 heads、segments、Session payload、attachments、tombstones、acks 和孤儿对象；
5. 最后关闭本设备 automatic sync；
6. 本地 Session 保留。

instance ID 是内部 fencing token，不是用户可选择的 sync space 或公开 generation。其他设备精确读到 reset 或不同 instance 后必须暂停，不得自动重建；前台让用户选择 `Initialize and sync` 或暂时不处理。用户明确重新初始化意味着允许当前设备的本地 Session 建立一套新的云端数据。

清理与其他设备在途上传并发时，旧 writer 仍只写旧 instance 前缀；新初始化永远使用新的随机 instance，因此迟到对象不可见、不可复活。百度无法保证与离线 writer 并发时远端物理字节瞬时归零；逻辑 reset 必须先完成，剩余 orphan 由有宽限期且每批重验 current control 的 maintenance GC 最终清理。

## 调度和触发

automatic sync 提供 30 秒、1 分钟、5 分钟 maintenance interval，默认 30 秒。该 interval 控制完整的 manifest/health 检查与空闲重试，不是用户可见变更的最长传播时间。启用 automatic sync 时，实现还必须使用轻量 remote-head probe 和本地 outbox 检查，使一台设备提交的 Session 变更在另一台在线设备已经打开的同一 Session 中于 15 秒内可见。

每个新进程、新 automatic leader 或错误恢复后的 runtime 在第一次 push 前必须先验证 manifest，回放并投影 control log，再完成一次 remote head 和缺失 segment 的 receive/hydrate。这个启动 barrier 防止离线设备先上传已经被其他设备删除的旧 outbox，也防止云端已被重置后向无 manifest 的目录写入旧状态。barrier 成功后进入低延迟增量路径，不在每次消息提交前重复完整检查。

同一设备可能同时运行多个 TUI，甚至打开同一个 Session。它们共享 durable outbox、cursor 和 Session projection，但只有一个进程可以成为 automatic cloud worker；其他进程不得重复调用 provider、排队等待 direction lease，或把正常的 leader 竞争显示为同步失败。手动同步以及 device rename/revoke 先写入共享 SQLite 的 durable run request/control outbox，再由同一 leader 执行。每批 request 使用稳定 request ID，并由唯一 run ID、owner 和 claim timestamp 精确认领；只有仍持有设备租约的 owner 可以完成该批，超时 claim 可恢复为 pending。这样 leader 不能把执行过程中刚写入的新 request 错报为成功，也不能在失去租约后报告成功。automatic sync 关闭时，显式手动同步可以临时取得同一设备级 fence 后执行。leader 退出或失活后必须在 15 秒窗口内由其他进程接管。任一进程完成 remote projection 后，其他进程必须检测共享 cursor 的变化并刷新 Session 列表以及已经加载的 Session 内容，不能要求用户重开面板、Session 或应用。

轻量 probe 精确检查下一 control generation，并批量检查权威 membership 中的 remote device heads；没有变化时不得列出或下载完整 segment 历史。空闲 tick 只检查 outbox/head generation/cursor 等小型单调状态，不得每秒重新扫描全部 Session metadata。本地 outbox 非空时先以小批量 drain 提交 control intent，再提交 immutable segment 和本设备 head；发现 remote control/head 变化后只拉取缺失 generation。普通增量路径不递归列举历史 deletion archive；旧 archive 只作为 legacy 兼容数据，不能参与 v2 正确性或触发 Session 删除。maintenance interval 只控制 manifest/health 核验与 GC，不得阻塞上述快速收发路径。以下动作触发同步尝试：

- 用户执行 `Sync now`；
- scheduler 到期；
- 网络恢复；
- 应用启动且 automatic sync 已开启。

相同方向的并发请求合并。outbound 优先不等于允许 inbound 饥饿：automatic push 使用有限 segment burst，remote probe 到期后必须让出执行机会；一个方向的可重试失败不能永久阻塞另一方向。receive/hydrate 推进 cursor 后，即使没有本地 Session event，也必须及时发布 acknowledgement-only head。

provider 失败使用有上限的指数退避和抖动。automatic worker 持有一个可续租的设备级跨进程 lease；maintenance 必须在同一 leader、同一 lease 内串行执行，不能另起 detached worker。手动同步、云端初始化/加入/重置和其他 lifecycle 操作同样受该 fence 保护；续租失败必须中止 provider 请求，并在任何可变 head 发布或成功提交前再次核验租约，不能与新 leader 并行继续远端操作。只有发生有效远端操作时才显示右上角状态栏；传输完成立即消失，失败保留 stage、operation、稳定 kind、retryability 和脱敏原因。

## TUI

`/sync`、command palette 的 `Sync settings` 和 QuickStart 入口打开同一 workflow。`/sessions` 只读共享 SQLite 中由唯一 worker 持续刷新的 metadata，不得为了打开面板启动第二个 provider reader；选择 metadata-only Session 后，hydrate 请求仍由同一个 device worker 执行：

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

`/sessions` 默认展示本机 Session 和已索引的云端 metadata；cloud-only 行使用 `cloud` 标记。同步不再提供 `Current Sync Space` 或 `Synced` scope；Path + Target 筛选、设备本机 target 名称和 Location 展示由 RFC-0006 与 RFC-0009 共同定义。

## 安全与凭据边界

- 只使用用户为 OpenCode Transit 提供并存入 `Auth.Service` 的百度 AppKey、SecretKey 与 OAuth credential；
- 不读取浏览器、百度客户端、外部 CLI 或旧应用登录态；
- 日志、状态栏、Session、同步 payload 和模型上下文不得包含 AppKey、SecretKey、token、authorization code、旧 secure-store 内容或私有下载 URL；
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

- https://pan.baidu.com/union/doc/基础网盘服务/获取文件信息/查询文件信息/
- https://pan.baidu.com/union/doc/基础网盘服务/获取文件信息/获取文件列表/
- https://pan.baidu.com/union/doc/基础网盘服务/上传/预上传/
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
15. Mac 与 mywindows 使用同一 commit 的 `opencode-transit` 完成双向真实验收。
16. 百度一次 list 漏项、path metadata/dlink/content 短暂 404 不删除已知状态；恢复后无需手动同步即可收敛；
17. segment、head、deletion acknowledgement 与 local outbox 严格遵守提交顺序，任一步失败均可从 durable pending 状态恢复；
18. 同设备多个 TUI 只有一个 provider worker；leader 退出后 15 秒内接管，旧 worker 续租失败后停止；
19. 连续 outbound 写入期间的反向更新仍在 15 秒内可见；一方向失败时另一方向仍可取得进展；
20. 每台设备至少两个真实 TUI 完成交替同 Session、多 Session 并行、冷启动、短暂离线、leader failover 与删除不复活验收，记录每轮最大延迟而不是只记录平均值。
