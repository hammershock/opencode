---
id: 0008
title: TUI Input Interaction Defaults
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

# RFC-0008：TUI 输入模式与模型 Variant 快捷交互

## 摘要

规范本 fork 对 TUI 输入模式和模型 variant 快捷操作的少量调整。`/variants` 保持 upstream 的选择面板语义；Shell mode 不再因空输入上的 Backspace 自动退出，只能通过明确的 Escape action 取消。

这些行为不是 slash command toolkit 的职责，不应混入 RFC-0006 的 command override。

## Upstream baseline

当前 upstream 已提供：

- `/variants` 打开当前模型可用 variant 的选择面板；
- `variant.cycle` command 按当前模型声明的 variant 列表循环；
- `variant_cycle` keybinding，默认值为 `Ctrl+T`；
- `variant_list` 等可覆盖 keybinding 配置；
- Shell mode 中 Escape 退出；
- Shell mode 输入为空且光标位于起点时，Backspace 也退出。

## 决策一：保持 `/variants` 语义

本 fork 不 override `/variants`。它继续只负责打开选择面板，不解析 provider-specific reasoning 参数，也不触发 Agent。

reasoning effort 在 OpenCode 中由当前模型的 variant 表示。快捷操作必须使用 provider/model 已声明的有序 variant 列表，不能根据 `low`、`high`、`max` 等字符串自行猜测顺序，也不能在 TUI 中硬编码模型 ID。

v1 保留 upstream 的 `variant.cycle` 与默认 `Ctrl+T`，不额外增加未经验证的 increase/decrease 默认键。用户仍可通过 `/variants` 精确选择，并通过现有 keybinding 配置覆盖 `variant_cycle` 或 `variant_list`。未来配置界面如支持 keybinding 编辑，应展示并修改同一份配置，不能维护 TUI-only 的第二份映射。

如果后续确认需要单向 increase/decrease，应先增加独立的 `variant.increase` 与 `variant.decrease` actions，再为其配置按键；不能把方向逻辑塞入 `/variants` handler。

## 决策二：Shell mode 只由 Escape 取消

删除“Shell mode 空输入时 Backspace 退出”的专用 binding。目标行为：

- Backspace 始终执行普通输入删除；输入已经为空时无操作；
- 删除最后一个字符后仍停留在 Shell mode；
- Escape 调用明确的 `prompt.shell.exit` action，并返回 normal mode；
- autocomplete、dialog 或其他拥有键盘焦点的组件仍优先处理自己的 Escape，不得穿透后误退 Shell mode；
- 退出 Shell mode 不提交内容、不写入 history、不创建 Session message、不调用 Agent；
- 正常提交 Shell command 后是否返回 normal mode保持 upstream 行为，本 RFC 只改变取消方式。

`prompt.shell.exit` 应成为可测试的 command/action identity。默认绑定为 Escape；如 keybinding 系统允许用户覆盖，UI footer 应显示实际绑定而非硬编码 `esc` 文案。

## 客户端和配置范围

- v1 只调整 TUI；Web/Desktop composer 和 Terminal panel 不受影响。
- variant 选择继续使用设备本地模型偏好存储，不写入历史消息以外的新 Session 状态。
- Shell mode 的当前状态是组件运行时状态，不写入用户配置或 Session。
- keybinding override 继续使用 upstream TUI keybind 配置格式。

## 验收条件

1. `/variants` 与没有 fork patch 时的 upstream 行为一致。
2. `variant.cycle` 只在当前模型声明的 variants 中移动，并保留可配置的 `Ctrl+T` 默认值。
3. Shell mode 中空输入、单字符和多字符场景下的 Backspace 都不会退出模式。
4. Escape 在 prompt 拥有焦点时退出 Shell mode；autocomplete/dialog 获得焦点时遵守焦点优先级。
5. Shell mode 取消不提交命令、不写 history/Session，也不触发 Agent。
6. footer 从有效 keybinding 映射生成提示，不硬编码 Escape 文案。
