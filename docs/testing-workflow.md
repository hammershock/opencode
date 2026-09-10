# Fork Testing Workflow

Every functional change in this fork must pass automated verification and real-device acceptance. Unit tests alone are insufficient because Location, SSH/Rexd, TUI input, secure storage, provider authentication and multi-device synchronization depend on real operating-system behavior. Fork-owned TUI checks also follow [`ui-design-guidelines.md`](ui-design-guidelines.md).

## Required test ladder

Run tests in this order:

1. **Static checks:** formatting or lint checks required by the affected package, generated-file checks and package-local `bun typecheck`.
2. **Unit tests:** parsers, state transitions, reducers, cryptographic envelopes, conflict rules and failure classification.
3. **Contract tests:** boundaries between Core, Location providers, Rexd protocol, command toolkit, provider adapters and sync adapters.
4. **Integration tests:** real process/database/filesystem behavior in temporary isolated state, including cancellation, crash recovery and retries.
5. **Real-device acceptance:** execute the built `opencode-rexd` on both the Mac and `mywindows`/WSL2 and exercise the scenarios affected by the task.
6. **Milestone regression:** before merging a complete RFC milestone, run the full cross-device matrix rather than only the task-specific rows.

A lower layer cannot waive a higher layer. When a scenario is genuinely platform-specific, the issue and PR must explain why one device is not applicable and add an equivalent negative or compatibility check on that device. Convenience or temporary device unavailability is not a waiver; the task remains incomplete until the required device run succeeds.

## Canonical devices and entrypoint

All fork acceptance uses the command name:

```text
opencode-rexd
```

Do not replace or overwrite the upstream `opencode` command. Installation directly replaces the existing `opencode-rexd` build after validating the candidate; it does not retain an old-build compatibility or rollback copy.

Canonical environments:

| Device      | Environment                               | Required invocation boundary                                                                                                                                                      |
| ----------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mac         | macOS on Apple Silicon                    | Run the locally built/installed `opencode-rexd` directly                                                                                                                          |
| `mywindows` | WSL2 distribution `Ubuntu`, user `hammer` | Connect with `ssh mywindows`, then explicitly invoke `wsl.exe -d Ubuntu -u hammer`; set a Linux HOME/cwd explicitly and never inherit `/mnt/c/Users/Mickey` as the test workspace |

Record the actual hostname, OS/architecture, Git commit, executable path, `--version` output and executable hash for every real-device run. Both devices must test binaries built from the same accepted commit; platform-specific build artifacts may differ.

## Isolation and data safety

- Use a unique temporary test workspace, target label and Session title prefix for each run.
- Never run destructive cases against personal workspaces, production Session IDs or an unscoped cloud directory.
- Tests that remove a target definition must first preserve the exact test fixture and restore it after the scenario. They must not alter unrelated Rexd targets.
- Tests must never print or persist SSH keys, OAuth tokens, recovery keys, `.env` secret values, provider credentials or decrypted sync payloads in logs or screenshots.
- Real credential and secure-storage tests assert presence, identity and behavior through redacted diagnostics; they do not snapshot secret values.
- Clean up test Sessions through product/domain deletion so tombstone behavior is exercised. Filesystem cleanup is allowed only for isolated test artifacts after state has been verified.
- Existing Rexd connection configuration is durable test infrastructure and must not be purged with Session data.

## Task-level real-device gate

Every functional task issue names the relevant rows below. After automated checks pass, its owner installs the exact candidate build as `opencode-rexd` on both devices and records evidence in the PR.

Minimum evidence:

```md
## Real-device acceptance

Commit:
Build/version/hash:

### Mac

- Environment and target:
- Scenarios:
- Result:
- Redacted log/artifact path:

### mywindows / WSL2

- Environment and target:
- Scenarios:
- Result:
- Redacted log/artifact path:

### Cleanup

- Test Sessions deleted globally:
- Temporary targets/workspaces removed or restored:
- Previous binary restored if required:
```

Screenshots or recordings are mandatory for TUI-visible behavior. Logs are mandatory for protocol, retry, fallback, sync and deletion behavior. Evidence may be attached to the PR rather than committed to the repository when it contains machine-specific metadata.

## Real-device matrix

### A. Local Location

Run on both Mac and WSL2:

- QuickStart selects local and an explicit working directory rather than inheriting the launcher cwd.
- Agent filesystem/process tools, User Shell and Terminal resolve the same Session Location.
- User Shell cwd continuity follows RFC-0004 during the process and disappears after restart.
- completion works without leaking helper startup state into execution.
- bare shell execution receives the RFC-0005 layered EnvironmentSnapshot.

### B. Rexd remote Location

At minimum run Mac to a configured Linux Rexd target and exercise `mywindows` as a target when the task affects Windows/WSL bridging:

- target wizard/import, validation and directory completion operate on the target;
- managed daemon installation and protocol/capability handshake report each failure phase;
- Agent tools, User Shell, files, mutations and Terminal PTY operate remotely;
- cancellation, disconnect and reconnect respect side-effect/retry rules;
- no connection or capability failure falls back to Mac-local execution.

### C. Environment and Shell

- target base environment is detected on the actual target, not the control device;
- target user `.env`, project `.env` and explicit process environment apply in the specified order;
- `/env list`, reload and init obey masking and transaction rules;
- Terminal restart/stale behavior is visible after reload;
- shell startup files do not run for normal commands;
- local and Rexd User Shell execution use the same bounded one-shot contract; a deliberately blocked command is cancelled at the boundary, preserves cwd, and directs interactive work to Terminal;
- Backspace and Escape behavior, completion, cwd and Agent isolation match RFC-0004 and RFC-0008.

### D. Target recovery and rebind

- removing an isolated target definition makes all referencing test Sessions unresolved and read-only;
- cloud portable target name is a hint only and never auto-selects a connection;
- restoring the original target ID recovers the batch while independently invalid directories remain unresolved;
- portable-label binding works independently on each device;
- force rebind changes only the selected Session and does not modify other Sessions, the registry or label bindings.

### E. Command toolkit and overrides

- external/upstream commands keep upstream resolution and execution behavior;
- every override setting off yields the unmodified upstream handler;
- setting on and compatible installs the decorator;
- runtime installation failure preserves upstream behavior and emits the required warning;
- a synthetic upstream contract drift fails typecheck/build rather than waiting for runtime.

### F. Provider usage

- adapters only receive credentials already managed by the active OpenCode provider connection;
- browser, provider CLI and external application login state are not discovered;
- adapter timeout, schema drift or authentication failure does not block model use;
- usage data never enters Session history, Agent context, export or sync payload.

### G. Multi-device Session sync

Before designing or changing a cloud-provider adapter, qualify the real account against a dedicated, exact test prefix. This is a release prerequisite, not evidence that mocks or documentation may replace. Record sanitized requests, provider codes and observed visibility latency for: missing singleton and batched metadata; absent-only create; unknown create outcome; mutable replacement; paginated recursive listing; metadata-to-download consistency; missing-object deletion; and immediate read-after-write/read-after-replace behavior. Repeat the probe from both supported devices when their HTTP stacks or credential stores differ. Do not attribute a failed product scenario to the provider until this probe reproduces it independently of Core sync state.

Run bidirectionally between Mac and `mywindows`:

- the TUI completes the product-owned Baidu OAuth flow without requesting AppKey, SecretKey or an external login state;
- OAuth completion leaves automatic sync disabled and offers `Enable and sync now`, `Enable` and `Keep disabled`;
- the fixed account-wide manifest is the only initialization fact; missing or incompatible manifests never accept uploads;
- explicit initialization backfills every existing Session, and every future Session participates without assignment or a user-visible space;
- disabling automatic sync stops queue consumption while durable outbox events continue to accumulate and later resume from checkpoints;
- `/sessions` keeps its device-local Path and Target filters stable while delayed cloud metadata is discovered;
- initial metadata appears before lazy content hydration;
- each device can create and append while the other is offline, then converge deterministically;
- attachments and large tool payloads hydrate, verify and retry independently;
- target ID, SSH configuration, credentials, `.env` values, OpenCode configuration and UI/runtime state never upload;
- v1 payloads use the specified plaintext codec and the UI does not expose encryption or recovery-key concepts;
- an unbound portable target remains unresolved until the device-local wizard binds it;
- sibling conflict results are identical under reversed pull order;
- production setup does not discover or migrate the archived prototype login. A separate explicit test fixture may reuse its exact secure-store identity to test compatibility without exposing the credential.

### H. Global deletion non-resurrection

Run the scenario in both directions, once with Mac deleting and once with `mywindows` deleting:

1. Device A deletes a synced Session.
2. Device B remains offline with old heads, materialized content and a pending old mutation/outbox.
3. Device A uploads the deletion marker and freezes the required device-ID set.
4. Device B reconnects and pulls the deletion. Interrupt it before its replacement head is uploaded; verify no acknowledgement exists and cloud payload is retained.
5. Resume B: it deletes local state, publishes a head without the Session, then publishes its idempotent acknowledgement.
6. Trigger garbage-collection eligibility, restart and repeat projection rebuild.
7. Verify neither device nor a newly connected device recreates the Session; after every required device has acknowledged or been revoked, its payload, attachment, marker and acknowledgements are gone.

This is a release-blocking regression. Payload garbage collection may occur only after acknowledgements whose corresponding replacement heads are already durable. Any resurrection is a correctness and data-loss-class failure; do not ship or merge around it.

For account-wide cloud reset, verify the manifest is invalidated before object cleanup. An interrupted cleanup may leave orphan objects, but another device must treat the root as uninitialized, pause automatic sync and request an explicit decision. Reinitialization clears those orphans before publishing a new manifest; cancellation disables automatic sync.

### I. TUI interaction

- QuickStart production prompt reaches a focused first paint, echoes sustained keyboard input within a bounded automated deadline, and keeps global keymap commands dispatchable;
- `Shift+Up` and `Shift+Down` move through declared variants without wrapping;
- `Ctrl+T` retains upstream cycle behavior;
- autocomplete and modal focus take priority over variant shortcuts;
- Backspace on empty User Shell input does not exit; Escape does;
- slash command panels and warning/fallback states render without entering model context.
- fork Core commands resolve to the same identity and availability from slash autocomplete, direct submit and `Ctrl+P`.
- User Shell and path completion share the eight-row candidate interaction; accepting a candidate never submits or executes.
- `/permissions` distinguishes device Default from durable Session mode; changing either leaves the other unchanged, and old Sessions open in normal mode.
- `/sessions` keeps search separate from the Path and Target rows; `Tab` changes row focus, left/right changes the focused row, and `Cwd` only coexists with `local`.
- list statuses use the shared symbols, remain right-aligned as asynchronous state changes, expose long errors only in focused detail and contain no emoji.
- v1 sync setup and management are present only in the TUI; Web/Desktop retain upstream behavior and expose no partial sync product flow.

## Legacy prototypes

The archived implementations are evidence and prototypes, not an implementation baseline. Tests may reuse their scenarios, fixtures after sanitization, protocol lessons and reproduced failures. Production code must follow the accepted RFCs and current package contracts; do not cherry-pick a legacy feature wholesale.

In particular, preserve regression coverage for the legacy sync resurrection failures, TUI-owned remote execution, persisted Shell cwd and control-device `.env` resolution. The archived forced-encryption and login-reuse product flows are not compatibility requirements: plaintext is now the default space codec, and the exact old secure-store identity is allowed only in explicit compatibility tests. A new implementation passes only when old resurrection and cross-scope failure modes are structurally impossible or covered by a failing test.

## Merge and release rules

- A PR cannot be marked Done until its relevant Mac and `mywindows` evidence is present.
- A task that passes locally but fails on one canonical device remains open.
- Flaky real-device behavior is a defect to diagnose, not a passing retry.
- A milestone release requires the complete matrix for all RFCs included in that milestone.
- The tester records cleanup and confirms `opencode-rexd` still points to the intended build on both devices.
