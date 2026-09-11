---
id: 0007
title: Provider Usage Surfaces
status: accepted
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-06
implemented-by:
  - https://github.com/hammershock/opencode-transit/pull/86
depends-on:
  - 0003
supersedes: []
superseded-by: []
---

# RFC-0007：Provider 使用量查询与展示

## 摘要

为不同模型 provider 提供可扩展的使用量查询能力，并在 `/models` 面板与 Session footer 中展示可靠的余额、配额或限流窗口信息。使用量是控制面瞬时状态，不写入 Session transcript，不进入模型上下文，也不能阻塞模型选择或正常对话。

本 RFC 将 provider usage 从 RFC-0006 的 `/models` override 中抽离。`/models` 只是一个消费者；查询、归一化、缓存、安全和 provider adapter 由本 RFC 统一规定。

## 目标

1. 一个 provider-neutral usage contract 支持多个 provider 独立扩展。
2. `/models` 面板按 provider 展示可用 usage，并允许显式刷新。
3. Session footer 展示当前模型所属 provider 的简短 usage 注脚。
4. 不支持、未认证、失败和过期数据具有不同状态，不能伪装成零余额。
5. 查询失败不影响 provider 连接、模型选择、prompt 提交或已有 Session。
6. Provider Usage 功能默认开启，并且只复用 OpenCode 当前已保存、已解析且用于模型请求的 provider 凭据。

## 非目标

- 根据本地 token 统计猜测 provider 账户余额；
- 统一不同 provider 的商业计费单位；
- 自动充值、购买额度或切换账户；
- 把 usage 写入 Session、同步数据或模型上下文；
- 绕过 provider 官方认证方式抓取网页；
- 读取或复用浏览器、provider CLI、其他应用或操作系统中的外部登录态；
- 为查询 usage 单独登录、发现账户或导入 OpenCode 尚未保存的 credential；
- 在 v1 向第三方插件开放不稳定的 provider usage API。

## 领域模型

```text
ProviderUsageSnapshot {
  providerID
  accountID?
  scopeID?
  fetchedAt
  expiresAt?
  status: available | unsupported | unauthenticated | error
  source: official_api | response_headers | experimental_private
  meters: ProviderUsageMeter[]
}

ProviderUsageMeter {
  id
  label
  kind: balance | quota | rate_limit | credits | custom
  used?
  remaining?
  limit?
  unit
  resetsAt?
  order
}
```

`unit` 必须保留 provider 原始语义，例如 currency、credits、requests、tokens 或 percentage。Core 不把不同单位换算成一个虚构的统一百分比。只有同时存在 `remaining` 与 `limit`，或 provider 直接返回可靠 percentage 时，UI 才可显示进度比例。

`accountID` 只能是适合展示和区分缓存的非敏感稳定标识；不得包含 access token、完整 secret 或未经允许的私人信息。

`scopeID` 表示本次真实模型请求使用的 organization/project 等 provider scope。Session footer 只显示当前模型、账户和请求 scope 的 snapshot；`/models` 可以展示同一账户下已经可靠发现的其他 scopes，但不能把它们相加成账户总额。

## Adapter 边界

每个受支持 provider 由独立 adapter 实现：

```text
ProviderUsageAdapter {
  providerID
  supports(auth, providerConfig)
  fetch(signal): ProviderUsageSnapshot
}
```

adapter 必须：

- 只使用 OpenCode provider authentication/config service 为当前连接解析出的已保存 credential；usage service 不拥有额外的 credential discovery 或登录能力；
- 只调用 provider 明确提供且适合该认证方式的 usage、quota、billing 或 rate-limit API；
- 将 provider-specific response 转换为通用 snapshot，同时保留无法通用化的 meter label/unit；
- 为响应 schema、认证错误、限流、超时和字段缺失提供测试；
- 不记录 authorization header、token、cookie 或完整原始响应；
- 不把 provider 失败转换成 `remaining: 0`。

adapter 可以使用三类来源：

1. provider 文档化的官方 usage/balance/quota API；
2. 真实模型响应中 provider 官方定义的 rate-limit headers；
3. 为满足 OpenAI OAuth/Codex 订阅配额而保留的、明确标记为 experimental 的私有兼容 endpoint。

第三类 adapter 必须独立版本化、严格验证 response schema、使用短超时，并在任何漂移、认证错误或字段缺失时返回 unsupported/error。它不能成为模型调用的前置条件，也不能把私有 endpoint 描述成 OpenAI 公共 API。

即使 provider 的网页、桌面客户端或官方 CLI 已经登录，adapter 也不能读取其 cookie、token、credential store、CLI config 或系统级单点登录状态。只有当前 OpenCode 连接本身已经持有兼容 credential 时，usage adapter 才可启用；否则返回 `unauthenticated` 或 `unsupported`，不得发起交互式登录。OpenCode 断开或移除该 credential 后，usage 查询能力与相关 cache 必须同时失效。

新增 provider 只增加 adapter 与 contract tests，不修改 `/models` 或 Session footer 的业务逻辑。service 对所有已连接 provider 运行 capability probe；没有可靠数据源的 provider 返回 `unsupported`。

旧实现提供了 OpenAI OAuth、DeepSeek、Moonshot CN 和 MiniMax adapters。v1 重新审查后保留以下基线：

- DeepSeek 使用官方 [`GET /user/balance`](https://api-docs.deepseek.com/api/get-user-balance)；
- Moonshot CN 使用官方 [`GET /v1/users/me/balance`](https://platform.moonshot.cn/docs/api/balance)；
- MiniMax Token Plan 使用[当前官方文档声明的 remains endpoint](https://platform.minimaxi.com/docs/token-plan/faq)，不沿用已经漂移的旧 URL；
- OpenAI API Key 从[官方定义的 rate-limit response headers](https://developers.openai.com/api/docs/guides/rate-limits) 更新 meters；
- OpenAI OAuth/Codex 可以使用旧 `wham/usage` 兼容 adapter，但其 `source` 必须是 `experimental_private`。

这些是首批迁移对象而不是封闭 allowlist。其他已连接 provider 仍执行 probe，并在未来通过独立 adapter 提交扩展。

v1 provider ID 与区域端点的支持矩阵如下。表中每个 ID 都只读取该 ID 在 OpenCode 中保存的 credential；相似名称之间不借用 key，也不从外部登录态补全：

| Provider family    | OpenCode provider IDs                                                    | Usage source                                                                              |
| ------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| OpenAI             | `openai`                                                                 | API key 的响应 rate-limit headers，或当前 OpenCode OAuth credential 的实验性 `wham/usage` |
| DeepSeek           | `deepseek`                                                               | `api.deepseek.com/user/balance`                                                           |
| Moonshot           | `moonshotai`, `moonshotai-cn`                                            | 与模型连接同区域的 `.ai` / `.cn` `v1/users/me/balance`                                    |
| MiniMax Token Plan | `minimax`, `minimax-coding-plan`, `minimax-cn`, `minimax-cn-coding-plan` | 与模型连接同区域的 `.io` / `.com` `v1/token_plan/remains`                                 |

名称相近但不在表内的 provider（包括代理网关、聚合服务或其他厂商的 Token Plan）不会复用上述 adapter。它们在有独立的官方 usage contract 和 adapter 之前保持 `unsupported`。

## 查询与缓存

1. Provider Usage service 默认启用；usage 查询由控制设备发起，不属于 Session Location，也不经过 Rexd。
2. cache key 至少包含 providerID、非敏感 account identity 和当前模型请求实际使用的 organization/project identity。
3. 默认使用短时内存缓存；具体 TTL 可由 adapter 在合理上限内声明。
4. 相同 cache key 的并发请求合并为一个 in-flight request。
5. `/models` 的 refresh action 绕过 fresh cache，但仍执行并发合并和速率保护。
6. 有最近成功快照时，刷新失败可以展示带时间戳的 stale 数据并同时标记 error；不能把 stale 数据显示为实时值。
7. 没有成功快照时，超时或错误只显示 unavailable/error，不阻塞其他 provider。
8. 断开账户、认证身份改变或 provider config 重载时清除相关 cache。

## `/models` 面板

RFC-0006 保持 `/models` 的模型选择功能。本 RFC 只添加 usage presentation：

- provider header 或详情区域显示其最有用的一个摘要 meter；
- 用户可以展开查看该 provider 返回的全部 meters、更新时间和 reset time；
- 已连接 provider 的查询可以并发执行，但 UI 需要限制全局并发并支持取消；
- loading、unsupported、unauthenticated、error 和 stale 使用不同文案；
- usage 排版不得破坏搜索、收藏、provider 分组或模型选择快捷键；
- refresh 只刷新 usage，不重新加载 provider credential，也不改变当前模型。
- Favorites 不再集中在单一分组；按 provider 分组，并在对应 provider header 使用同一 usage presentation。

## Session footer 注脚

Session footer 只显示当前所选模型 provider 和实际请求 scope 的单行摘要，例如：

```text
OpenAI · 72% left · resets 14:00
Provider X · ¥18.20
```

边界如下：

- footer 复用同一 usage service/cache，不自行请求 provider；
- 模型或认证账户改变时切换 cache key；
- provider turn 完成后可以异步 revalidate，但不能延迟消息完成；
- 没有可靠信息时省略注脚，不显示估算值；
- 注脚只是 UI，不序列化到 Session，也不计入导出 transcript。
- 每个 provider 使用设备级用户偏好保存一个有序 meter ID 列表；用户在 `/models` provider 区域选择、隐藏和重排 footer 项目。
- 尚未配置偏好时，按 adapter 的稳定 `order` 顺次显示全部有效 meters；失效或不存在的已选 meter 自动跳过，但保留偏好以便恢复。
- footer 始终使用一行，从左到右排列所选有效信息；超出可用宽度时按用户顺序从尾部截断并显示省略提示，不能改变选择或另起多行。

## 安全与隐私

- usage endpoint 与模型调用使用同等级别的 credential 保护。
- usage service 的认证能力严格小于等于 OpenCode 当前 provider 连接：只能借用该连接已经解析的 credential，不能从外部登录态补全或扩大账户访问范围。
- UI 只显示完成任务所需的账户和额度摘要；原始账单、付款方式与个人资料不进入通用 snapshot。
- 错误日志按 provider、阶段和错误类型记录，认证值与敏感 response 字段必须脱敏。
- 远程 target、Rexd 和云同步不能读取 provider usage credential 或 cache。

## 实现阶段

1. 定义 usage schema、service、cache 和 adapter contract tests。
2. 迁移并审查 OpenAI、DeepSeek、Moonshot CN 和 MiniMax adapters，再为其他已连接 provider 增加 capability probes。
3. 接入 `/models` provider 分组展示和 refresh action。
4. 接入当前 Session provider footer 注脚。
5. 按 provider 独立增加 adapters；每个 adapter 使用单独实现提交。

## 验收条件

1. usage service 与 UI 不包含按 providerID 分支堆叠；provider-specific 逻辑只存在于 adapter。
2. available、unsupported、unauthenticated、error 和 stale 状态均有行为测试。
3. 缓存、请求合并、显式刷新、取消和认证变化失效均有测试。
4. `/models` 查询失败不影响搜索、选择或 prompt 提交。
5. Session footer 只显示当前 provider 的可靠摘要，且不进入 Session、同步数据、导出或 Agent context。
6. 日志、错误与 snapshot 不泄露 provider credential 或敏感原始响应。
7. 所有已连接 provider 都经过 adapter probe；首批四类旧 adapters 有 fixture、schema drift、认证、限流和超时测试。
8. OpenAI 私有兼容 endpoint 失效只移除 usage 展示，不影响认证、模型发现、选择或请求。
9. `/models` 按 provider 分组 Favorites；footer 的默认全量顺序、用户选择、重排、失效 meter 和单行截断均有测试。
10. Provider Usage 默认开启；只有 OpenCode 已保存并用于当前 provider 连接的 credential 可被 adapter 使用，外部登录态、额外 credential discovery 和交互式登录均有拒绝测试。
