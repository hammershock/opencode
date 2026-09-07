---
id: 0010
title: Multi-device Session Sync
status: accepted
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-07
implemented-by:
  - https://github.com/hammershock/opencode/pull/86
depends-on:
  - 0002
  - 0003
supersedes: []
superseded-by: []
---

# RFC-0010：多设备 Session 同步

## 摘要

为 OpenCode Core 增加 provider-neutral 的多设备 Session 同步能力，并以百度网盘作为 v1 storage provider。用户通过 OpenCode 提供的百度 OAuth 流程连接账户，在该账户下创建或加入彼此隔离的 sync space；一台设备同一时刻最多有一个 active sync space。

同步只覆盖明确归属于某个 sync space 的完整 Session 事件和持久化附件。它不承担 OpenCode 配置、target、workspace 文件或 UI 状态同步。space 可以选择端到端加密，但 v1 默认关闭加密；无论编码模式如何，空间隔离、完整性校验、durable outbox、tombstone 和确定性收敛都必须成立。

本 RFC 继承旧原型已经验证的 EventV2、per-device head、immutable segment、durable outbox、跨进程 lease、tombstone 和 sibling conflict 经验，但旧原型及其云端状态不是协议或迁移来源。

## 目标

1. 同步归属于 active sync space 的 Session，包括 messages、parts、reasoning、tool payload、标题、关系、可移植 Location metadata 和 Session 内持久化附件。
2. 一个 Session 最多归属于一个 sync space；不同空间的索引、outbox、cursor、对象和删除事实严格隔离。
3. 同一百度账户下的兼容空间可被发现；用户可以创建、加入、切换和全局删除空间，但每台设备只有一个 active space。
4. 不同步 workspace 普通文件、OpenCode 配置、设备本地 target 定义、SSH 配置、provider/Baidu 凭据、Location 环境值或客户端临时 UI 状态。
5. 多设备离线编辑后确定性收敛，不使用最后上传覆盖整个数据库。
6. 百度网盘失败、离线或限流不阻塞未归属或已物化 Session 的本地使用。
7. macOS 与 WSL v1 均使用系统安全存储保存百度凭据和可选的空间密钥。

## 客户端范围

v1 产品界面只在 TUI 提供，包括 OAuth、space 管理、状态、Session scope 和设备管理。Web/Desktop 不获得同步设置、空间切换或 recovery-key UI，也不能仅因底层 API 存在就宣称支持同步。

Core、Protocol 和 provider adapter 仍保持客户端无关，以便测试和未来客户端复用；TUI 只调用类型化 Sync service，不直接访问百度 API、credential、对象编码或 conflict projector。未来扩展 Web/Desktop 必须单独规定交互、安全存储和验收矩阵。

## Domain ownership

OpenCode EventV2 Session 数据库是本地会话事实源。同步层观察正式 domain events、维护按 space 分区的 durable outbox，并通过同一 Session projector 回放远端事件；不得直接把远端数据库文件覆盖到本地。

```text
owned Session domain events
  -> space-scoped sync outbox
  -> optional encryption codec
  -> SyncProvider adapter
  -> space/device heads, segments and chunks
  -> pull/verify/decode/merge
  -> Session domain projector
```

Session domain 持久化可选的 `syncSpaceID`。缺少该字段表示未归属：不会被后台扫描或上传，也不会因某个空间变为 active 而自动加入。新 Session 在 active space 存在时默认归属于该空间；没有 active space 时保持未归属。改变归属必须是显式 domain workflow；v1 不支持在两个空间间原地移动或复制同一 Session ID。

## 账户、空间与本地状态

非敏感账户、空间 catalog 和同步状态位于解析后的 OpenCode 用户配置目录下：

```text
<OpenCode user config directory>/sync/config.json
<OpenCode user config directory>/sync/state.json
<OpenCode user config directory>/sync/sync.db
```

`config.json` 只保存 provider、账户引用、本设备 ID/name、active space ID、enabled 和调度参数。`state.json` 保存可重建的空间摘要和诊断。`sync.db` 使用 WAL，所有 outbox、cursor、object cache、lease 和 deletion marker 都以 sync space ID 分区。普通文件不保存 OAuth token、可选 root key 或 recovery string。

正式实现只解码当前 `config.json` schema。文件声明旧的或不受支持的版本时，Core 必须在访问安全存储前停止，并通过稳定的 `incompatible-local-state` reason 告知 TUI；TUI 显示简短的手动归档与重启说明。检测不得读取、迁移或复用旧登录态，也不得自动删除、改写、移动或解释旧文件。当前 `Remove sync from this device` 依赖已经成功解码的 v2 state，因此不能作为不兼容文件的恢复路径；事务性的 archive/reset workflow 若需要加入，必须由后续 RFC 定义其文件范围、回滚与失败语义。

账户下的每个 space 至少具有随机稳定 ID、用户可见名称、协议版本、编码模式和成员摘要。规则如下：

- OAuth 登录只建立百度账户连接并发现 space catalog，不创建、加入或激活任何 space；用户必须在登录完成后显式创建或进入一个 space；
- 一台设备同时至多一个 active space；切换必须先停止旧空间调度、释放 lease，再原子更新 active identity；
- active 只控制后台 upload/pull 和新 Session 的默认归属，不改变已有 Session ownership；
- `Switch` 只改变 active space；旧空间的本机 membership/binding、space key、outbox、cursor 和 Session ownership 全部保留，且不会转投新空间；
- 同一账户下各空间可列出摘要，但只有 active space 可以拉取 cloud-only Session metadata；
- 不支持的协议版本只显示只读摘要和兼容性诊断，不能加入、写入、删除或尝试降级；
- `Leave on this device` 只针对所选 space：停止其本机调度，移除本机 membership/binding、space key 和该空间的本地同步状态，并将其已物化 Session 转为未归属；本地 Session 和云端 space 均不删除，也不会把 Session 上传到另一个 active space；
- 删除 space 是账户范围的破坏性操作，写入永久、单调的 space deletion marker。任何设备的旧 catalog、head、outbox 或缓存都不能复活该空间。

## 百度 OAuth 产品流程

百度 v1 使用 OpenCode 产品注册的 OAuth client。TUI setup 只提供清晰的 `Connect Baidu Netdisk` 流程：打开或展示授权地址、接收授权结果、校验账户，然后将 refresh/access credential 写入系统安全存储。普通用户不填写 AppKey、SecretKey，不粘贴 token，也不选择外部应用登录态。

产品 OAuth client 由发布流程在候选构建验证后从标准输入静默写入系统安全存储的固定 `opencode-rexd-sync` / `baidu:app` 记录。输入不经过参数、环境变量、配置、manifest、日志或临时文件；写入后必须回读验证，失败时恢复旧记录且不替换已安装版本。该入口不出现在普通 CLI help 或 TUI 中。运行时缺少产品记录时只提示重新安装官方构建或联系分发者，不引导用户输入应用凭据。

HTTP/SDK 边界只公开稳定的 `missing-app`、`incompatible-local-state` 原因码及各自固定提示；其他 setup 失败统一为不携带内部原因的 `bad-request`。后者只描述设备本地格式不兼容，不携带旧文件内容、版本细节、路径或安全存储信息。

授权优先使用本机 loopback callback。无法自动回调时可以展示并复制授权 URL，再由用户粘贴授权码；该 installed-app fallback 只允许百度协议要求的精确 literal `oob` redirect。除明确的 loopback 与 `oob` 两种情况外，redirect 必须是 HTTPS，不能接受任意 HTTP URL、自定义 scheme 或调用方提供的其他非 HTTPS redirect。

- macOS 使用 Keychain；
- WSL 使用宿主 Windows PasswordVault；
- WSL 不能只依赖进程启动时的 `WSL_INTEROP`，应发现 `/run/WSL/*_interop` 中仍有效的候选；
- 无法访问安全存储时进入 locked/credential-error，不回退明文文件；
- v1 不承诺原生 Linux Secret Service 或独立 Windows 客户端。

旧 OpenCode 原型的 Keychain/PasswordVault 登录态只用于自动化与真实设备兼容测试，以证明 adapter 可以复现既有账户场景。正式产品不得发现、迁移或复用旧 identity，也不得扫描浏览器、百度客户端、CloudDrive、`netdisk` CLI 或其他应用登录态。测试必须显式注入精确 legacy fixture identity，且不得把 secret 或机器 identity 写入仓库、日志或截图。

登录与进入 space 是两个独立的产品步骤。OAuth 成功后界面显示账户和可发现的空间，但保持 `activeSpaceID` 未设置，直到用户显式创建或进入空间。重新登录也不得根据旧 catalog、同名空间或本地 Session 自动选择 active space。

账户退出和完整移除是不同操作：

- `Log out` 停止调度、清除 active selection 并移除本设备的百度 credential，但保留本地 space catalog、密钥、同步状态、outbox 和 Session ownership，以便同一账户重新授权并显式重新进入后恢复；
- `Remove sync from this device` 对本机已知的所有 space 执行本地 leave，停止全部调度，清除百度 credential、全部 membership/binding、space key、catalog、outbox、cursor、cache 和同步设置，并将本地已经物化的 Session 变为未归属；云端 space、全局删除 marker 和其他设备不受影响；
- 两种操作都不得删除本地 Session；完整移除是破坏本机恢复材料的操作，必须确认并说明加密空间可能需要 recovery key 才能再次进入。

## 可选端到端加密

创建 space 时用户可以开启端到端加密；默认关闭，创建后编码模式不可原地切换。需要改变模式时创建新 space，并通过未来另行定义的显式 export/import 或 copy workflow 迁移，不得在原路径混放两种编码。

未加密 space 使用带版本的 canonical envelope、内容摘要和对象路径绑定来检测损坏，但不承诺对百度存储隐藏 Session 内容。UI 必须在创建前明确说明这一点，状态页持续显示 `Encryption: Off`，不能用锁形符号或含糊文案暗示加密。

未加密 space 不生成、不请求、导入或保存 root key/recovery key；OAuth credential 只授权 provider 访问，不能被当作内容加密密钥。编码模式写入 space descriptor，创建后不可变。

加密 space 使用运行时审计过的 AES-256-GCM、HKDF-SHA256、HMAC-SHA256 和系统 CSPRNG：

- setup 生成随机 256-bit root key；导出的 recovery string 带版本、space ID 和 checksum，只通过敏感临时 dialog 展示；
- root key 通过 HKDF 按协议版本和用途派生 metadata、event、attachment 与 object-ID 子密钥；
- payload canonical encode、压缩后以随机 96-bit nonce 加密，对象 identity 和 schema metadata 进入 AAD；
- chunk ID 使用 keyed HMAC，密钥、nonce、明文 hash 和解密 payload 不进入普通日志；
- 所有设备丢失 key 时内容不可恢复，OAuth 账户不能替代 recovery key。

两种模式都必须先验证 envelope、对象 identity、摘要和 schema，再推进 cursor。加密空间额外拒绝错误 key、nonce、AAD 或 tag。任何验证失败都隔离对象并保持本地可恢复状态。

## Provider contract 与百度布局

```text
SyncProvider {
  list(prefix, cursor?)
  stat(path)
  download(path, version?)
  uploadAtomic(path, bytes, precondition?)
  delete(paths)
}
```

Core 只依赖该 contract。百度 adapter 负责 OAuth、分页、precreate、分块上传、dlink 下载、fsID/version、重试分类和 API 限流，不解释 Session、space ownership 或 conflict payload。

默认远端布局：

```text
/apps/opencode-sync/
  catalog/<spaceID>.space
  deleted-spaces/<spaceID>.marker
  spaces/<spaceID>/
    protocol.json
    devices/<deviceID>.head
    devices/<deviceID>.name
    segments/<deviceID>/<from>-<to>
    chunks/<opaqueChunkID>
```

加密模式下对应 metadata/head/segment/chunk 使用 encrypted envelope；未加密模式使用 canonical plaintext envelope。space ID 必须进入所有本地复合键、远端路径、precondition 和验证上下文。代码不能依赖“当前 active”隐式补齐一个已经持久化事件的空间。

## 增量、索引与调度

- Session durable event 在 Session 数据库中原子提交，并作为跨数据库 capture journal；space-scoped outbox 以 event ID 幂等、至少一次地从该 journal 捕获，再异步上传。启动时必须先订阅 live durable stream，再修复 ownership 并回放完整已归属历史，使进程在 Session commit 与 outbox capture 之间崩溃也不会丢事件；上传成功并更新本设备 head 后才清除 outbox；
- Session 数据库中的 `syncSpaceID` 是仍存在 Session 的 canonical membership：启动恢复必须用全部 Session 行修复 ownership，显式 `NULL` 清除崩溃遗留的旧 ownership，非空值修复 assign/space-switch 中断；已经删除而没有 Session 行的 aggregate 保留旧 ownership，只用于把最终 tombstone 路由回原空间；
- enabled 时按用户级配置对 active space 调度；v1 只提供 30 秒、1 分钟、5 分钟三个 interval preset，默认 30 秒；启动、网络恢复和 `/sync now` 也触发，相同方向请求合并；
- upload 与 pull 使用按 space、device、方向隔离的跨进程 lease 和 TTL；
- 每个 device head 携带该设备已知的最小永久 Session deletion set。任何上传都必须先索引远端 head、吸收并投影其中的删除事实，再处理本机 outbox；因此离线旧设备不能先发布陈旧 metadata 再得知删除；
- pull 的对象验证、事件回放、冲突分支和 projection 全部提交后，才原子推进该 space 的 cursor；
- 首次加入 active space 先获取 Session metadata projection，使 `/sessions` 可以搜索，再按需或限流后台 hydration；
- metadata-only 索引先应用 head 中的 deletion set，再合并并过滤 Session metadata；不允许为了维持 metadata-first 浏览而暂时展示已被其他设备永久删除的 Session；
- 非 active space 只使用本机已有摘要和已物化数据，不后台访问其 cloud-only metadata；
- 未归属 Session 永远不进入任何后台 outbox。

## Session scope 与 TUI

`/sync`、command palette 中的 `Sync settings` 和 QuickStart 的同步设置入口必须打开同一个 TUI workflow，不得各自实现状态机或确认逻辑。该 workflow 提供 connect/logout/remove account、create/enter/switch/leave/delete space、enable/disable、interval、sync now、status，以及加密空间的 export/import recovery key。`/devices` 深链到同一 workflow 的 active-space Devices 子视图；返回时回到同一个 Sync settings overview，而不是另一套设备管理面板。所有操作是 RFC-0003 控制面效果，不进入 Session 或模型上下文。

如果 active space 存在且本机仍有未归属 Session，打开 Sync settings overview 时可显示一次批量提示：`Add all` 或 `No`。提示 identity 由 active space ID 与当时未归属 Session ID 的精确快照共同决定；关闭提示等价于 `No`，同一组内容再次打开面板不重复提示，未归属集合变化后可以重新提示。成功创建、进入或切换 active space 也可以触发相同规则的提示。用户显式执行 `Sync now` 时则始终重新提供这次选择，不受已拒绝 identity 抑制。启动、后台同步和定时调度不得主动弹窗，也不得自动归属。

确认只提交提示快照中的精确 Session ID；期间新建、删除或已经改变归属的 Session 不被意外纳入，Core 在提交时再次筛选仍为未归属的 ID。`No` 保持全部 Session 未归属。归属操作必须通过 Session domain workflow 产生初始 outbox，不能由 TUI 直接修改字段；显式 `Sync now` 中完成归属后，应再执行一次同步以发送新产生的 outbox。

`/sessions` 在搜索框之外固定显示两个独立筛选维度：

```text
Filter: [Cwd] All
Scope:  [Current Sync Space] All
```

`Scope: Current Sync Space` 只显示归属于 active space 的 Session，不包含未归属 Session。`Scope: All` 显示本机已有的所有空间归属 Session 和未归属 Session，但不查询非 active space 的 cloud-only metadata，也不切换 active space。`Tab` 在 Filter 与 Scope 两行间切换焦点，左右键切换当前值；搜索框独立工作。筛选只是 view state，不修改 ownership。

Session 行只用稳定、简短的文字和统一状态符号表达 `metadata-only`、`hydrating`、`ready`、`partial`、`conflict`、`unresolved`。状态列右对齐；错误详情在聚焦、详情面板或用户操作失败时展示，不把长句塞入每一行。不得使用 emoji 作为状态、操作或装饰。具体视觉规则见 [`../ui-design-guidelines.md`](../ui-design-guidelines.md)。

## 删除、设备与垃圾回收

同步中的 `/delete` 对 Session 所属空间始终是全设备删除：本地删除与 durable tombstone/outbox 一起提交；其他设备拉取后删除 projection 和已物化内容。同步 disabled、space 非 active 或离线时，删除仍留在其原空间 outbox，只有该空间再次 active 并可同步时传播。它绝不能转投当前其他 active space。

tombstone 对同一 space ID 与 Session ID 组合永久、单调地占优。删除后的旧 segment、离线迟交 event、旧 outbox、旧 head、hydration 和重装缓存均不得复活 Session。Session ID 不在空间内复用；恢复内容只能 fork 为新 ID。

本机吸收远端 deletion set 时，先在同步数据库提交永久 marker 并清除尚未封装的同 Session outbox，再以幂等方式删除 Session projection。跨数据库投影若中途崩溃，下一次 head 索引必须重复投影删除；不能因为 marker 已存在而跳过恢复。

所有未撤销设备 ack 后可以回收 payload 和冗余 tombstone object，但必须在该空间的 deletion set 永久保留最小 marker。撤销设备只改变成员与 ack 语义。加密 space 若要排除已持有 key 的设备，必须全局删除旧 space 并创建使用新 key 的空间。

全局删除 space 同样使用永久 deletion marker。删除完成后本机该空间不再 active，后台任务停止；每台设备应用该 marker 时保留已经物化的本地 Session，并清除这些 Session 的 `syncSpaceID`，使其成为未归属 Session。它们不会自动加入其他空间；未来若要重新同步，必须走显式的新归属 workflow。尚未物化的 cloud-only metadata 可以清除。

## 冲突与可移植 Location

同一 space/aggregate/seq 的 event ID、type 和 canonical payload 全部相同才是重复；任一不同即为分叉冲突：

- Session owner device 分支优先；无法区分时较小稳定 device ID 获胜；
- loser 从首次冲突 seq 起物化为确定性 sibling Session ID，并保留完整历史和同一 space ownership；
- metadata 使用 domain revision，相同 revision 以稳定 device ID 决胜；
- Session 和 space deletion marker 胜过对应 identity 的全部旧事件；
- conflict resolution 持久化，所有设备在不同拉取顺序下得到相同结果。

云端 Location 只保存 owner device、可移植 target label、directory、revision 和更新 device，不保存设备本地 target ID。其他设备必须显式绑定 label；未绑定、target 不存在或目录无效时 Session 保持可读且 unresolved。RFC-0009 rebind 产生该 Session 所属空间内的新 Location revision。

## 状态与错误

同步状态使用稳定词汇：`off`、`idle`、`syncing`、`locked`、`attention`。列表内容状态使用 `metadata-only`、`hydrating`、`ready`、`partial`、`conflict`、`unresolved`。provider stage 与可重试性属于诊断详情，不创造更多近义 UI 状态。

- 网络、限流和 5xx 使用带 jitter 的有界指数退避；认证失败等待重新授权；
- 上传结果未知时先 stat/verify，不盲目重复 finalize；
- corrupt/tampered、错误 key 和 schema/protocol mismatch 不覆盖对象或推进 cursor；
- 单个附件失败使 Session 保持 partial，不阻塞其他 Session；
- provider、space、stage、对象类型和可重试性进入脱敏结构化日志。

## 非目标

- 同步 OpenCode/user/project 配置、target registry、workspace Git checkout 或任意目录文件；
- 同步 SSH key、`.env`、provider credential、百度 credential、Default approval mode 或 TUI view state；
- 实时协同编辑同一个 turn；
- 同时激活或后台同步多个 space；
- 自动把未归属 Session 上传到 active space；
- v1 在空间间移动、复制或导入 Session；
- Web/Desktop 同步 UI；
- 产品流程复用旧 OpenCode 或外部应用登录态；
- 原生 Linux、独立 Windows 或移动端 v1 客户端。

## 验收条件

1. 未归属 Session 不因 enable、active-space 切换、重启或后台扫描而上传；新 Session 只在创建时继承当时的 active space。
2. 每个事件、outbox、cursor、lease、cache、对象路径和 deletion marker 都按 space 隔离，切换空间不会跨空间上传或投影。
3. 每台设备只有一个 active space；`Scope: All` 不访问非 active space 的 cloud-only metadata，也不改变 active identity。
4. 未加密 space 是默认路径，UI 明确显示 Encryption Off；加密 space 的 tamper、错误 key/nonce/AAD 和 recovery 流程通过测试。
5. 百度产品 OAuth、refresh、分页、上传、下载、限流和结果未知恢复通过 adapter 与 Mac/WSL 真实测试；用户无需提供 AppKey/SecretKey。
6. 正式产品代码不发现或迁移旧登录态；旧 identity 只存在于显式、脱敏的测试 fixture 和兼容验收中。
7. 两设备离线追加、同 seq 分叉、metadata revision 冲突和 sibling 收敛在不同拉取顺序下结果一致。
8. Session 删除和 space 删除经乱序、离线迟交、旧 outbox、重启、hydration 和 compaction 后均不能复活；space 删除在所有设备保留已物化 Session 并将其转为未归属。
9. `/sessions` 按规范显示搜索、两行 Filter/Scope、右对齐状态和简短无 emoji 文案；键盘焦点与筛选不修改 durable state。
10. portable label 未绑定时保持 unresolved；绑定后通过 RFC-0002 验证才能执行，连接详情从未上传。
11. 同步失败、locked 或 disabled 时本地 Session 使用仍可用，原所属空间 outbox 保留可恢复状态。
12. TUI 命令只使用 toolkit 和 Sync service；Web/Desktop 不暴露未验收的同步产品入口。
13. OAuth 成功不自动进入空间；`/sync`、command palette 和 QuickStart 共用一个 workflow，`/devices` 只深链到其中的 Devices 子视图。
14. 30 秒、1 分钟、5 分钟 interval 均可选择且默认 30 秒；logout 保留本地同步身份与恢复状态，Switch 只改变 active，单空间 Leave 只移除该空间的本机状态和 ownership，完整移除对所有空间执行本地移除并清除 auth/state；三者均保留本地 Session。
15. 未归属 Session 按 active space 与精确 ID 集合记忆一次面板提示；关闭等价于拒绝，同一集合不重复提示，集合变化后可再次提示。显式 `Sync now` 始终允许重新选择，后台调度和启动不会弹窗或隐式归属；提交只作用于提示快照中仍未归属的 Session。
