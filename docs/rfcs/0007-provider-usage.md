---
id: 0007
title: Provider Usage Surfaces
status: draft
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-06
implemented-by: []
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

## 非目标

- 根据本地 token 统计猜测 provider 账户余额；
- 统一不同 provider 的商业计费单位；
- 自动充值、购买额度或切换账户；
- 把 usage 写入 Session、同步数据或模型上下文；
- 绕过 provider 官方认证方式抓取网页；
- 在 v1 向第三方插件开放不稳定的 provider usage API。

## 领域模型

```text
ProviderUsageSnapshot {
  providerID
  accountID?
  fetchedAt
  expiresAt?
  status: available | unsupported | unauthenticated | error
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
}
```

`unit` 必须保留 provider 原始语义，例如 currency、credits、requests、tokens 或 percentage。Core 不把不同单位换算成一个虚构的统一百分比。只有同时存在 `remaining` 与 `limit`，或 provider 直接返回可靠 percentage 时，UI 才可显示进度比例。

`accountID` 只能是适合展示和区分缓存的非敏感稳定标识；不得包含 access token、完整 secret 或未经允许的私人信息。

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

- 使用 OpenCode 已建立的 provider authentication/config service，不自行读取散落的 credential 文件；
- 只调用 provider 明确提供且适合该认证方式的 usage、quota、billing 或 rate-limit API；
- 将 provider-specific response 转换为通用 snapshot，同时保留无法通用化的 meter label/unit；
- 为响应 schema、认证错误、限流、超时和字段缺失提供测试；
- 不记录 authorization header、token、cookie 或完整原始响应；
- 不把 provider 失败转换成 `remaining: 0`。

新增 provider 只增加 adapter 与 contract tests，不修改 `/models` 或 Session footer 的业务逻辑。首批 provider 清单在实现计划中单独确认；没有可靠 API 的 provider 返回 `unsupported`。

## 查询与缓存

1. usage 查询由控制设备上的 Provider Usage service 发起，不属于 Session Location，也不经过 Rexd。
2. cache key 至少包含 providerID、非敏感 account identity 和影响配额范围的 organization/project identity。
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

## Session footer 注脚

Session footer 只显示当前所选模型 provider 的紧凑摘要，例如：

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

## 安全与隐私

- usage endpoint 与模型调用使用同等级别的 credential 保护。
- UI 只显示完成任务所需的账户和额度摘要；原始账单、付款方式与个人资料不进入通用 snapshot。
- 错误日志按 provider、阶段和错误类型记录，认证值与敏感 response 字段必须脱敏。
- 远程 target、Rexd 和云同步不能读取 provider usage credential 或 cache。

## 实现阶段

1. 定义 usage schema、service、cache 和 adapter contract tests。
2. 选择至少一个具有可靠官方 usage API 的 provider 实现端到端 adapter。
3. 接入 `/models` provider 分组展示和 refresh action。
4. 接入当前 Session provider footer 注脚。
5. 按 provider 独立增加 adapters；每个 adapter 使用单独实现提交。

## 待确认问题

1. 哪些 provider 具有我们可以稳定调用的官方 usage API，并作为首批支持对象？
2. 不同 provider 的多 organization/project 配额应如何让用户选择展示 scope？
3. 哪些 meter 适合作为 provider header 和 Session footer 的默认摘要？

## 验收条件

1. usage service 与 UI 不包含按 providerID 分支堆叠；provider-specific 逻辑只存在于 adapter。
2. available、unsupported、unauthenticated、error 和 stale 状态均有行为测试。
3. 缓存、请求合并、显式刷新、取消和认证变化失效均有测试。
4. `/models` 查询失败不影响搜索、选择或 prompt 提交。
5. Session footer 只显示当前 provider 的可靠摘要，且不进入 Session、同步数据、导出或 Agent context。
6. 日志、错误与 snapshot 不泄露 provider credential 或敏感原始响应。
