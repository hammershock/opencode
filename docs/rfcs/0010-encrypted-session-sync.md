---
id: 0010
title: Encrypted Multi-device Session Sync
status: accepted
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-06
implemented-by: []
depends-on:
  - 0002
  - 0003
supersedes: []
superseded-by: []
---

# RFC-0010：端到端加密的多设备 Session 同步

## 摘要

为 OpenCode Core 增加 provider-neutral 的多设备 Session 同步能力，并以百度网盘作为 v1 storage provider。同步覆盖完整 Session 事件和持久化附件，采用客户端端到端加密；云存储只能看到版本、对象大小和不透明名称，不能读取 Session 内容、标题、目录或设备信息。

本 RFC 继承旧原型已经验证的 EventV2、per-device head、immutable segment、durable outbox、跨进程 lease、tombstone 和 sibling conflict 方案，但将同步 domain 从 TUI 工具文件下沉到 Core，增加加密、按需恢复、附件分块和 provider adapter。

## 目标

1. 启用后同步已有及新建的全部 Session，包括 messages、parts、reasoning、tool payload、标题、关系、可移植 Location metadata 和 Session 内持久化附件。
2. 不同步 workspace 普通文件、设备本地 target 定义、SSH 配置、provider/Baidu 凭据、Location 环境值或客户端临时 UI 状态。
3. 多设备离线编辑后确定性收敛，不使用最后上传覆盖整个数据库。
4. 百度网盘失败、离线或限流不阻塞本地 Session 使用。
5. 新设备先获得可搜索的 Session 索引，再按需或后台物化完整内容。
6. macOS 与 WSL v1 均使用系统安全存储保存同步 key 和百度凭据。

## Domain ownership

OpenCode EventV2 Session 数据库是本地会话事实源。同步层观察正式 domain events、维护 durable outbox，并通过同一 Session projector 回放远端事件；不得直接把远端数据库文件覆盖到本地。

```text
Session domain events
  -> encrypted sync outbox
  -> SyncProvider adapter
  -> per-device encrypted heads/segments/chunks
  -> pull/verify/decrypt/merge
  -> Session domain projector
```

TUI、`/sync`、`/devices` 和 `/sessions` 只调用类型化 Sync service。百度 API、加密、冲突和 cursor 逻辑不能出现在 prompt handler 或 UI component。

## 配置、设备与凭据

非敏感配置和同步状态位于解析后的 OpenCode 用户配置目录下：

```text
<OpenCode user config directory>/sync/config.json
<OpenCode user config directory>/sync/state.json
<OpenCode user config directory>/sync/sync.db
```

`config.json` 保存 provider、namespace ID、随机 device ID、用户可修改的 device name、enabled、30 秒默认 interval 和远端 root，不保存 key、token、AppKey 或 SecretKey。`sync.db` 使用 WAL，保存 outbox、cursors、object cache、local-only 标记和 upload/pull leases。

百度 v1 使用用户自己的开发者 AppKey/SecretKey。配置向导收集凭据、打开 OAuth authorization、交换并刷新 token；AppKey、SecretKey、access token、refresh token 和 sync root key 全部保存到：

- macOS：Keychain；
- WSL：宿主 Windows PasswordVault。

WSL 不能只依赖进程启动时的 `WSL_INTEROP`。实现沿用旧原型经验，发现 `/run/WSL/*_interop` 中仍有效的候选并逐个尝试，以支持 tmux、CloudShell 和断线重连。无法访问安全存储时同步进入 locked/credential-error，不回退明文文件。

v1 不承诺原生 Linux Secret Service 或独立 Windows 客户端。

## Recovery key 与同步空间

首次 setup 生成随机 256-bit root key 和随机 namespace ID。导出格式是带版本和 checksum 的 recovery string，同时包含 namespace ID 与 root key；只通过明确标为敏感的临时 dialog 展示或复制，不进入 Session、Shell history、日志或同步数据。

新设备必须由用户手动导入 recovery string，并使用同一个百度账户完成 OAuth。导入成功后把 key 写入本机安全存储；云端不存在可用用户密码解锁的 key envelope。

所有设备丢失 key 时，旧密文不可恢复。用户可以主动执行 `Reset sync space`：

1. 展示旧空间将永久删除且不可恢复的警告；
2. 要求明确的破坏性确认；
3. 删除百度网盘旧 namespace 下的全部对象；
4. 生成新 namespace、root key 和 recovery string；
5. 以当前设备的非 local-only Session 初始化新空间；
6. 用户手动把新 recovery string 分发到其他设备。

部分删除或远端删除失败时不启用新 namespace，保留可重试诊断，避免两个空间同时成为 active source。

## 加密与对象完整性

使用运行时审计过的 AES-256-GCM、HKDF-SHA256、HMAC-SHA256 和系统 CSPRNG，不实现自定义密码算法。

- root key 通过 HKDF 按协议版本和用途派生 metadata、event、attachment 与 object-ID 子密钥；
- JSON/event payload 先 canonical encode 和压缩，再使用随机 96-bit nonce 加密；
- encrypted envelope 只暴露 protocol version、key epoch、nonce、ciphertext 和认证 tag；
- object path/type、device ID、generation、segment range 与 schema version 作为 AEAD associated data，防止对象替换；
- 解密或 schema 校验失败时隔离对象并报告 corrupt/tampered，不推进 cursor；
- key、nonce、明文 hash 和解密后的原始 payload 不进入普通日志。

持久化附件和大型 tool payload 按固定上限分块。chunk ID 使用 object-ID 子密钥对明文 chunk 做 HMAC-SHA256，因此同一同步空间内可以去重，而云存储不能用公开 hash 猜测内容。首次上传的 chunk 使用随机 nonce 加密；相同 chunk ID 已存在且 envelope 校验通过时复用。manifest 记录有序 chunk IDs、总大小、媒体类型和整体认证信息，并单独加密。

## Provider contract 与百度网盘布局

```text
SyncProvider {
  list(prefix, cursor?)
  stat(path)
  download(path, version?)
  uploadAtomic(path, bytes, precondition?)
  delete(paths)
}
```

Core 只依赖该 contract。百度 adapter 负责 OAuth、分页、precreate、分块上传、dlink 下载、fsID/version、重试分类和 API 限流，不解释 Session 或加密 payload。

默认远端布局：

```text
/apps/opencode-sync/<namespaceID>/
  protocol.json
  devices/<deviceID>.head.enc
  devices/<deviceID>.name.enc
  segments/<deviceID>/<from>-<to>.enc
  chunks/<opaqueChunkID>.enc
```

每个 device 只写自己的 head/name 文件。head 保存加密的 hot generations、ack 和 Session metadata projection；达到阈值后封存为不可变 segment。设备不共同修改单个 manifest，从文件布局上避免依赖百度网盘的跨设备锁。

`protocol.json` 只含读取加密 envelope 所需的非敏感版本和 namespace metadata，不含设备名称、Session 索引或 key 验证明文。

## 增量、索引与调度

- 本地 durable mutation 先写 Session domain 与 sync outbox，再异步上传；上传成功并更新本设备 head 后才清除 outbox。
- title、delete、Location rebind 等用户刚触发的 durable metadata 进行一次立即 upload attempt；失败进入指数退避。
- enabled 时约每 30 秒执行 pull 和失败任务补偿；应用启动、网络恢复和用户 `/sync now` 也触发，但相同方向的并发请求合并。
- upload 与 pull 使用独立跨进程 lease 和 TTL；同一设备多个 OpenCode 进程不能重复提交或回放。
- 一次 pull 的对象验证、事件回放、冲突分支和 projection 全部提交后，才原子推进对应 remote cursor。

首次同步先下载各设备 head 并解密 Session metadata projection，使 `/sessions` 可以显示和搜索标题、device、portable target label、directory、时间、同步状态与内容可用性。打开未物化 Session 时按引用下载完整 segments/chunks；空闲时可以限流后台 hydration。下载失败保持 metadata-only，不伪装为空 Session。

## Session 范围与 local-only

启用同步后，已有和新建的全部 Session 默认进入同步。Session 中已持久化的图片、文件附件、reasoning 和大型 tool payload 均加密、去重并分块；workspace 中没有作为 Session payload 持久化的普通文件不上传。

用户可以执行 `Keep only on this device`：

1. 把当前 Session 标记为 local-only，并保证 collector 不再上传该 ID；
2. 写入全局 tombstone，使云端和其他设备删除已有副本；
3. 当前设备保留完整本地 Session。

local-only Session 以后若重新加入同步，必须复制为新的 Session ID；原 ID 的 tombstone 继续有效，避免离线设备复活旧副本。

## 删除、设备与垃圾回收

同步中的 `/delete` 默认是全设备删除：本地删除成功后立即写 durable tombstone/outbox；其他设备拉取后删除 projection 和已物化内容，并忽略该 Session 的更旧事件。恢复内容必须显式 fork 为新 Session ID，不能移除 tombstone 复活原 ID。

tombstone 只有在所有未撤销设备通过 head ack 后才可以在 compaction 中清理，同时回收不再被引用的 segment 和 chunk。没有固定时间替代 ack。长期离线或丢失设备必须由用户在 `/devices` 中撤销，撤销后不再阻塞垃圾回收。

v1 的设备撤销是同步成员与 ack 语义，不是对已经持有 recovery key 和百度凭据的恶意设备进行密码学隔离。需要排除可能泄露 key 的设备时，用户必须执行同步空间 reset 并分发新 key。

## 冲突与收敛

同一 aggregate/seq 的 event ID、type 和 canonical payload 全部相同才是重复；任一不同即为分叉冲突：

- Session owner device 的分支优先保留为主 Session；owner 无法区分时，较小的稳定 device ID 获胜；
- loser 从首次冲突 seq 起物化为确定性 sibling Session ID，并保留完整历史；
- conflict resolution 本身写入同步操作，所有设备重复计算得到相同结果；
- title 等 metadata 使用 domain revision；revision 较高者胜，相同 revision 使用稳定 device ID 决胜；
- tombstone 胜过其创建前及未见 tombstone 的离线旧事件，不允许旧 head 复活 Session。

冲突不得丢弃 loser payload，也不得只在 toast 中提示而不持久化结果。

## 可移植 Location

云端 Location 只保存 owner device、可移植 target label、directory、revision 和更新 device，不保存 RFC-0002 的设备本地 target ID。

- local-owner 表示创建/绑定位置的 owner device 本地环境；其他设备必须显式把该语义映射到一个本地 target，不能直接在自己的 local 执行。
- named label 在每台设备上通过 `/devices` 或 Session location UI 显式绑定到本地不可变 target ID。
- 没有 binding、target 不存在或 directory 验证失败时，Session 仍可查看，但执行位置是 unresolved。
- RFC-0009 rebind 成功后产生新 Location revision；失败或尚未提交的候选位置不进入同步。

## Commands 与 UI

以下 Core command 使用 RFC-0003 toolkit，全部是控制面效果，不进入 Session 或模型上下文：

- `/sync setup`：配置百度 OAuth、设备、recovery key 和初次同步；
- `/sync status`：显示 provider、namespace、device、lock、cursor、outbox、最近成功和脱敏错误；
- `/sync now`：立即执行合并后的 upload/pull；
- `/sync enable|disable`：切换设备级后台同步，不删除数据；
- `/sync export-key|import-key`：通过敏感 dialog 导出或导入 recovery string；
- `/sync reset`：执行破坏性的同步空间 reset；
- `/devices`：列出、重命名和撤销设备，并管理 portable target label binding。

`/sessions` 展示 metadata-only/hydrating/ready/conflict/local-only/unresolved 状态，并支持搜索 device、label 和 directory。UI 不直接访问百度 adapter 或解密对象。

## 错误与重试

- 网络、百度限流和 5xx 使用带 jitter 的有界指数退避；认证失败等待用户重新授权。
- 上传结果未知时先 stat/verify 目标对象，不盲目重复有副作用的 finalize。
- corrupt/tampered、错误 key、unsupported protocol 和 schema mismatch 不自动覆盖远端对象或推进 cursor。
- 单个附件失败使对应 Session 保持 partial，并允许重试；不影响其他 Session metadata 同步。
- 本地数据库成功但云端失败时保留 outbox；云端成功但本地 ack 写入失败时通过幂等 object ID 和 head generation 恢复。
- 所有错误按 provider、阶段、对象类型和可重试性分类，日志必须脱敏。

## 非目标

- 同步 workspace Git checkout 或任意目录文件；
- 同步 target 连接、SSH key、`.env` 值或 provider credential；
- 实时协同编辑同一个 turn；
- 把百度网盘当成跨设备锁服务；
- 原生 Linux、独立 Windows 或移动端 v1 客户端；
- 自动设备间传输 recovery key；
- 保证被撤销但仍持有 key/百度账户的恶意设备无法写入旧 namespace。

## 实现阶段

1. 从旧原型提取 provider-neutral event/outbox/head/segment contract 和 contract tests，落入 Core sync domain。
2. 实现 recovery key、安全存储、AEAD envelope、chunking、HMAC dedup 和 corruption tests。
3. 实现百度 SyncProvider、OAuth wizard、macOS Keychain 与 WSL PasswordVault。
4. 实现 encrypted metadata index、lazy hydration、background scheduler 和多进程 leases。
5. 接入 tombstone、local-only、device revoke、portable Location 和 deterministic sibling conflict。
6. 使用 RFC-0003 接入 `/sync`、`/devices`，并扩展 `/sessions` 状态展示。

## 验收条件

1. 云端 fixture 和日志不含 Session 明文、设备名称、目录、target label、credential、root key 或公开 plaintext hash。
2. AES-GCM tamper、错误 key/nonce/AAD、unsupported version 和 schema mismatch 均拒绝并不推进 cursor。
3. macOS Keychain、WSL PasswordVault 以及无初始 `WSL_INTEROP` 的 tmux 场景通过真实设备回归。
4. 百度分页、OAuth refresh、分块上传、下载、限流、失败重试和结果未知恢复均有 adapter tests。
5. 两设备创建、离线追加、同 seq 分叉、metadata revision 冲突和 sibling 收敛在不同拉取顺序下结果一致。
6. outbox、upload/pull lease、进程崩溃、重复对象和 cursor 原子提交测试证明不会丢事件或重复投影。
7. 新设备先出现可搜索 metadata，打开后正确 hydration；附件分块、去重、partial retry 和后台恢复可验证。
8. `/delete` 在其他设备删除且重启后不复活；所有有效设备 ack 前不回收 tombstone，撤销设备后可以回收。
9. local-only 操作全局删除其他副本、本机保留，并且重新同步时生成新 Session ID。
10. portable label 未绑定时保持 unresolved；绑定后通过 RFC-0002 验证才能执行，连接详情从未上传。
11. 同步失败、锁定或 disabled 时本地 Session 创建、执行和删除仍可用，outbox 保留可恢复状态。
12. 所有命令使用 toolkit 和 Sync service，不在 TUI 中维护第二套协议或直接持有 credential。
