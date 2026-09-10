# RFC Index

RFC（Request for Comments）用于记录本 fork 中影响多个模块或核心行为的设计决策。

| ID                                          | 标题                         | 状态     |
| ------------------------------------------- | ---------------------------- | -------- |
| [0001](0001-shell-execution-scope.md)       | Execution Scope Model        | Accepted |
| [0002](0002-rexd-remote-execution.md)       | Rexd Remote Execution        | Accepted |
| [0003](0003-command-effects.md)             | Core Command Toolkit         | Accepted |
| [0004](0004-user-shell-session.md)          | User Shell CWD Continuity    | Accepted |
| [0005](0005-location-environment.md)        | Location Environment Loading | Accepted |
| [0006](0006-builtin-command-adjustments.md) | Built-in Command Adjustments | Accepted |
| [0007](0007-provider-usage.md)              | Provider Usage Surfaces      | Accepted |
| [0008](0008-tui-input-interactions.md)      | TUI Input Interactions       | Accepted |
| [0009](0009-session-location-rebinding.md)  | Session Target Recovery      | Accepted |
| [0010](0010-encrypted-session-sync.md)      | Multi-device Session Sync    | Accepted |
| [0011](0011-location-aware-model-context.md) | Location-aware Model Context | Accepted |

## 状态

- `Draft`：设计仍可修改，不应开始大规模实现。
- `Accepted`：设计已经确认，可以据此拆分实现任务。
- `Implemented`：验收条件已经满足。
- `Superseded`：已由另一篇 RFC 替代，原文保留作为历史记录。
- `Rejected`：未采用，原文保留作为决策记录。
