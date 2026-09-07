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
- Use two rows only when the controls represent independent dimensions. For `/sessions`, the required controls are exactly:

  ```text
  Filter: [Cwd] All
  Scope:  [Current Sync Space] All
  ```

  The search input is separate. `Tab` moves between Filter and Scope; left/right changes the focused value.

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
- Every key-driven action exposed in a footer must use the configured keybinding label rather than a hard-coded key name, except when an RFC intentionally fixes the interaction.

## Async and error behavior

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

## Review checklist

- Does the surface preserve upstream navigation and configured keybindings?
- Are primary labels stable, statuses right-aligned and details progressively disclosed?
- Are status words and symbols drawn from the shared vocabulary, with no emoji?
- Can asynchronous failure leave focus, selection and durable state unchanged?
- Do completion and modal keys outrank global shortcuts, and can accepting a candidate avoid accidental submit?
- Is every destructive scope explicit, while normal reversible actions avoid redundant confirmation?
- Does the TUI consume typed domain state without owning credentials, transport or synchronization logic?
- Do all entry points reuse the owning workflow and its confirmation semantics rather than duplicate a feature-specific panel?
