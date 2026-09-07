---
id: 0008
title: TUI Input Interaction Defaults
status: accepted
authors:
  - hammershock
created: 2026-09-06
updated: 2026-09-06
implemented-by:
  - https://github.com/hammershock/opencode/pull/86
depends-on: []
supersedes: []
superseded-by: []
---

# RFC-0008：TUI 输入模式与模型 Variant 快捷交互

## 摘要

规范本 fork 对 TUI 输入模式和模型 variant 快捷操作的少量调整。`/variants` 保持 upstream 的选择面板语义；normal prompt 中使用 `Shift+↑/↓` 调整思考强度；Shell mode 不再因空输入上的 Backspace 自动退出，只能通过明确的 Escape action 取消。

这些行为不是 slash command toolkit 的职责，不应混入 RFC-0006 的 command override。

两项调整都是本 fork 的稳定默认行为，不放入实验性功能分区，也不设置迁移 feature flag。用户仍可通过 upstream keybinding 配置修改按键，但不能通过实验开关恢复空输入 Backspace 退出 Shell mode 的旧行为。

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

v1 保留 upstream 的 `variant.cycle` 与默认 `Ctrl+T`，同时增加两个方向明确、不循环的 actions：

- `variant.increase`：默认 `Shift+↑`，移动到下一个更强的 variant；
- `variant.decrease`：默认 `Shift+↓`，移动到下一个更弱的 variant。

强弱顺序必须来自当前 provider/model 声明的有序 variants。位于端点时保持当前值，不循环；当前值缺失时，以模型解析后的默认 variant 为基线。没有可用 variants 时不修改状态，并显示简短提示。

调整只影响后续 provider turn，不改变正在运行的 turn 或历史消息。结果写入与 `/variants` 选择器相同的设备本地模型偏好，不创建新的 Session message。

`Shift+↑/↓` 与 upstream 的 `input_select_up/down` 默认键存在冲突。本 fork 规定在 normal prompt 拥有焦点且没有 autocomplete、dialog 或其他 modal consumer 时，variant action 优先；Shell mode 和 modal 中仍由相应输入组件处理。需要保留纵向选择的用户可以通过现有 keybinding 配置覆盖 `variant_increase`、`variant_decrease`、`input_select_up` 和 `input_select_down`。未来配置界面如支持 keybinding 编辑，应修改同一份配置，不能维护 TUI-only 的第二份映射。

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
- 两项行为随 TUI 默认启用，不依赖 experimental setting。
- variant 选择继续使用设备本地模型偏好存储，不写入历史消息以外的新 Session 状态。
- Shell mode 的当前状态是组件运行时状态，不写入用户配置或 Session。
- keybinding override 继续使用 upstream TUI keybind 配置格式。

## 验收条件

1. `/variants` 与没有 fork patch 时的 upstream 行为一致。
2. `variant.cycle` 保留可配置的 `Ctrl+T` 默认值；`variant.increase/decrease` 默认使用 `Shift+↑/↓`，按 provider/model 声明的顺序移动且端点不循环。
3. normal prompt、Shell mode、autocomplete 和 dialog 的快捷键优先级有测试，不能同时触发 variant 与文本选择操作。
4. Shell mode 中空输入、单字符和多字符场景下的 Backspace 都不会退出模式。
5. Escape 在 prompt 拥有焦点时退出 Shell mode；autocomplete/dialog 获得焦点时遵守焦点优先级。
6. Shell mode 取消不提交命令、不写 history/Session，也不触发 Agent。
7. footer 从有效 keybinding 映射生成提示，不硬编码 Escape 文案。
8. 默认安装不需要开启实验选项即可获得两项交互，实验功能面板也不提供重复开关。
