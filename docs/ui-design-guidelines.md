# TUI UI Design Guidelines

This document defines the normative interaction and presentation rules for fork-owned TUI surfaces. It supplements feature RFCs; when an RFC specifies a stricter behavior, the RFC wins. It does not define Web/Desktop UI.

## Principles

1. Preserve upstream TUI patterns unless a reviewed fork requirement needs a difference.
2. Make the current value, focus and next safe action visible without explanatory paragraphs.
3. Keep domain state in Core services. Components render typed state and dispatch domain actions; they do not own a second protocol.
4. Prefer progressive disclosure: rows contain identity and status, focused details contain diagnostics, and confirmation dialogs are reserved for destructive or security-sensitive actions.
5. Keyboard and mouse actions must invoke the same command or domain workflow.
6. One product workflow owns one interaction state machine. Slash commands, the command palette, QuickStart and contextual actions deep-link to that workflow or one of its subviews instead of cloning panels and behavior.

## Layout and density

- Keep labels short and stable. Do not repeat information already present in the panel title or selected row.
- Align comparable values into columns. Status occupies a fixed, right-aligned trailing column so loading or error text does not move the primary label.
- A row should normally contain one primary label, one optional muted description and one status. Put verbose errors, paths or instructions in a focused footer or detail view.
- Prefer a symbol plus a stable text label over prose-only status or icon-only meaning. Symbols aid scanning; labels remain the accessible contract.
- Preserve panel geometry while asynchronous state changes. Loading must not reorder rows or replace the user's selection.
- Give every single-line row an explicit width budget and test it at the supported narrow, default and wide terminal widths. Reserve gutters and fixed right-side status before allocating identity text.
- Unfocused rows never auto-scroll. Truncate their variable text deterministically; when user-visible single-line content is genuinely longer than its budget, only the selected or mouse-focused row may cycle horizontally so the complete content remains inspectable. Keep the panel, every other row, and fixed metadata/status columns stationary; do not horizontally scroll the whole list.
- Use two rows only when the controls represent independent dimensions. For `/sessions`, the required controls are exactly:

  ```text
  Path:   [Cwd] All
  Target: [local] All mywindows a100-2gpu
  ```

  The search input is separate. `Tab` moves between Path and Target; left/right changes the focused value. `Cwd` only coexists with `local`; selecting another target or Target `All` moves Path to `All`.

## Status language and symbols

- Use one symbol vocabulary consistently. Recommended meanings are `●` healthy/ready, `◐` pending/checking, `!` attention or unavailable, and `×` destructive/failed. Color supplements the symbol but is never the only distinction.
- Put the symbol and shortest stable state at the right edge: for example `◐ checking`, `● ready`, or `! unavailable`.
- Use domain vocabulary rather than synonyms. Sync uses `off`, `idle`, `syncing`, `locked`, `attention`; Session content uses `metadata-only`, `hydrating`, `ready`, `partial`, `conflict`, `unresolved`.
- Do not use emoji for status, actions, warnings or decoration. Terminal width and glyph support are not reliable enough for normative UI.
- Do not show success toasts for passive background checks. Surface failure detail when focused or when a requested action fails.

## Input, completion and focus

- Candidate panels for User Shell and path prompts share one interaction model and structured replacement contract.
- Show at most eight candidate rows without scrolling. Keep the active candidate visible.
- `Tab` requests or applies completion; direction keys move; `Enter` accepts a candidate. Accepting a candidate must not submit a form or execute a Shell command.
- Unique completion may fill the input directly but still must not submit it.
- Input, cursor, scope or generation changes invalidate pending results. Late asynchronous results never steal focus or replace newer text.
- Modal focus, autocomplete and confirmation take precedence over global shortcuts. Closing a child surface returns focus to the element that opened it when that element still exists.
- A scrollable selector has one navigation-state owner. Keep its highlighted row, filter and viewport together inside the selector; `current` represents a committed domain value or an explicit initial anchor, not a cursor mirrored on every move.
- Never feed `onMove` into reactive state and pass that state back as `current`. That controlled-selection loop can queue stale asynchronous recenter operations during key repeat or wheel input, making a long list jump between old positions after the user has already moved on.
- Preserve a selection across option reloads by stable value inside the selector. If an external workflow must position the list, apply it once for the relevant data generation and cancel or supersede older scheduled scroll work; do not continuously recenter ordinary navigation.
- Exercise every scrollable dialog with more rows than its viewport. Rapid Up/Down, Page Up/Page Down and wheel input must remain monotonic while moving, then leave the viewport completely stationary after input stops; synthetic mouse movement caused by layout changes must not take over keyboard selection.
- Every key-driven action exposed in a footer must use the configured keybinding label rather than a hard-coded key name, except when an RFC intentionally fixes the interaction.
- Input whose first character is `/` is an explicit slash-command attempt. If no registered command matches, keep the input for correction, show `Slash command does not exist`, and stop before Session creation, prompt history, optimistic rendering or model-context admission. A slash elsewhere in ordinary text keeps its normal prompt meaning.

## Async and error behavior

- Sync 与 Rexd Target 共享右上角唯一的远端操作状态栏；各面板不得各自实现一套全局进度浮层。
- 用户触发远端操作后必须立即显示模块、操作和当前阶段。有效数据传输还应显示方向、对象种类、数量与字节增量；操作成功后对应状态立即消失。
- 失败状态保留到同模块的下一次操作或显式清除，并展示经过脱敏的阶段、transport/provider operation、稳定错误类别和可重试性。只显示 `failed`、`unavailable` 或 HTTP 状态码不构成充分诊断。
- 并发操作使用独立 identity；迟到的完成或失败只能更新自己的状态，不能清除或覆盖较新的操作。
- 状态栏是临时客户端运行态，不写入配置或 Session，不进入模型上下文。不得展示 credential、token、OAuth code、SSH secret、含秘密的命令、provider 原始响应或不必要的私有 URL。
- Opening a list may start bounded, non-blocking health checks. Render `checking` in place and retain navigation.
- A failed health check changes status and exposes a concise, redacted detail; it does not crash, close the panel, change selection or silently choose a fallback target/provider.
- Deduplicate concurrent checks for the same identity. Ignore results belonging to a closed view or stale generation.
- Retryable operations provide a visible retry action. Automatic retries must not repeatedly show toasts or reset focus.
- Never place credentials, recovery strings, environment values or raw provider responses in ordinary rows, toasts, screenshots or logs.

## Confirmation and safety

- Confirm only destructive, irreversible or trust-boundary actions, such as global Session/space deletion, recovery-key reset or an unknown SSH host-key decision.
- Do not add a confirmation merely to explain that a normal save may later fail validation. Save first, then report the actual actionable failure at use or verification time.
- Confirmation copy names the affected object and scope. A global action says global or all devices explicitly.
- The same domain action uses the same confirmation title, scope and consequences from every entry point. A deep link may choose the initial subview, but it must not bypass or invent a confirmation.
- Disabled actions explain the unmet condition in focused detail; do not hide an object merely because it is unavailable or unresolved.
- Sensitive collections must never offer implicit or bulk clipboard export. After the user has crossed the owning reveal/confirmation boundary, an explicit focused-row action may copy exactly one raw entry. Its success or failure feedback and logs name the action but never repeat the sensitive value.

## Review checklist

- Does the surface preserve upstream navigation and configured keybindings?
- Are primary labels stable, statuses right-aligned and details progressively disclosed?
- Are status words and symbols drawn from the shared vocabulary, with no emoji?
- Can asynchronous failure leave focus, selection and durable state unchanged?
- Do completion and modal keys outrank global shortcuts, and can accepting a candidate avoid accidental submit?
- Is every destructive scope explicit, while normal reversible actions avoid redundant confirmation?
- Does the TUI consume typed domain state without owning credentials, transport or synchronization logic?
- Do all entry points reuse the owning workflow and its confirmation semantics rather than duplicate a feature-specific panel?
- Does each scrollable selector have exactly one cursor/viewport owner, with no `onMove` → reactive `current` feedback or stale recenter work under rapid input?
