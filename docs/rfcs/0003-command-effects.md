---
id: 0003
title: Command Effects and Context Policy
status: draft
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-06
implemented-by: []
depends-on: []
supersedes: []
superseded-by: []
---

# RFC-0003：命令效果与上下文策略

## 摘要

规范 OpenCode 内建及自定义 slash command 的行为声明，明确区分命令执行的 action、是否写入 Session、是否投影到模型上下文，以及是否调用 Agent。

本 RFC 目前只记录需要解决的问题和初步术语，不在讨论完成前确定最终 Schema。

## 动机

OpenCode 中的“命令”目前包含不同性质的入口：

- `/help`、`/terminal` 等客户端控制命令；
- `/init` 和 custom command 等 prompt command；
- 未来的 `/env list`、`/env reload`、`/env init` 等混合命令组。

只用“slash command”无法说明一个命令是否创建消息、是否进入模型上下文或是否触发 Agent。新增命令时如果依赖调用路径的隐式行为，会使回放、审计和多客户端实现不一致。

## 初步效果维度

下面是待验证的概念模型，而不是最终字段名：

1. `action`：命令实际请求系统做什么，例如切换 UI、刷新 runtime state、执行 operation 或提交 prompt；
2. `conversationRecord`：是否产生持久化、可回放的 Session part；
3. `modelProjection`：哪些记录会进入当前或后续 Agent 的模型上下文；
4. `agentInvocation`：是否立即调用 Agent 或 subagent。

此前使用的 `runtimeEffect` 指“只发生在当前客户端或运行时中的动作”，例如打开 Terminal panel 或刷新环境快照。这个词过于宽泛，本 RFC 暂时改用 `action`，后续结合现有 command registry 再确定精确类型。

## 当前基线

| 入口                      | Action          | 写入 Session | 进入后续 Agent 上下文 | 立即调用 Agent |
| ------------------------- | --------------- | ------------ | --------------------- | -------------- |
| `/help`、`/terminal`      | UI control      | 否           | 否                    | 否             |
| `!command`                | Shell execute   | 是           | 是，包含命令及结果    | 否             |
| `/init`                   | Prompt submit   | 是           | 是                    | 是             |
| custom prompt command     | Prompt submit   | 是           | 是                    | 是或 subagent  |
| Terminal panel 输入与输出 | PTY interaction | 否           | 否                    | 否             |

`!command` 不是 slash command，但它是检验 Session 记录与模型投影边界的重要对照，因此保留在表中。

## 初步原则

- 是否写入 Session 与是否调用 Agent 必须分开表达。
- 进入模型上下文的数据原则上应有可审计、可回放的 Session 记录。
- secret-bearing runtime state 不得因为命令实现方便而自动投影到模型上下文。
- 效果策略由命令定义声明，不建议提供允许用户任意重分类所有命令的全局开关。
- 同一个命令在不同客户端上的核心记录和上下文语义必须一致；纯 UI action 可以由客户端分别实现。

## 待确认问题

1. 这些效果应由静态 command metadata、不同 command 类型，还是 handler 返回值表达？
2. `modelProjection` 是否需要独立于 Session part 类型配置，还是只允许由 part 类型决定？
3. 不调用 Agent 的 operation result 应使用哪种 Session part 表达？
4. 自定义 command 可以声明哪些效果，哪些效果只允许内建命令使用？
5. subagent command 的父 Session 应记录模板、展开结果、subtask 引用还是它们的组合？
6. 权限检查发生在 command 展开前还是具体 action 执行前？

## 非目标

- 定义持久 User Shell；
- 定义 `.env` 文件加载；
- 允许命令绕过现有权限系统；
- 让用户任意隐藏已经进入模型上下文的数据。
