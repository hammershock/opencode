# `opencode-transit` development entrypoint

Fork builds keep OpenCode's internal package identity and produce a separate executable named `opencode-transit`. They never install over the upstream `opencode` executable.

## Build

From `packages/opencode`, build the current platform with:

```bash
bun run script/transit-build.ts --single --skip-install
```

Release and cross-device acceptance can select one supported target without
building the full upstream matrix:

```bash
bun run script/transit-build.ts --target=linux-x64 --skip-install
```

The artifact is written below `dist/opencode-<platform>/bin/` as:

- `opencode-transit` — the executable;
- `opencode-transit.build.json` — product/upstream versions, commit, target, dirty-worktree flag, and build time.

The version contains the source commit, for example `1.18.29-transit.0+0123456789ab`. A `.dirty` suffix identifies builds made with uncommitted source changes. Acceptance builds must be made from a clean accepted commit.

## Install

Install the artifact on macOS or Linux/WSL without changing an existing `opencode` command:

```bash
./script/install-transit \
  --binary dist/opencode-darwin-arm64/bin/opencode-transit \
  --manifest dist/opencode-darwin-arm64/bin/opencode-transit.build.json
```

The default destination is the existing fork entrypoint at `~/.local/bin/opencode-transit`. Override it with `--install-dir` or `OPENCODE_TRANSIT_INSTALL_DIR`. The installer does not edit shell startup files and never writes `~/.local/bin/opencode`.

The installer validates the candidate before transactionally replacing the
existing `opencode-transit` entrypoint and manifest. It also installs an
`opencode-rexd` compatibility launcher for one Transit minor release; the
launcher prints a deprecation warning and forwards arguments and exit status.
Rexd connection configuration and user data are outside the build artifact and
are not modified by installation.

On macOS, repeated ad-hoc builds have a different code identity and can make
Keychain treat every replacement as a new application. Developers with a
trusted signing identity should preserve one stable application identity:

```bash
./script/install-transit \
  --binary dist/opencode-darwin-arm64/bin/opencode-transit \
  --manifest dist/opencode-darwin-arm64/bin/opencode-transit.build.json \
  --codesign-identity "Apple Development: account@example.com (TEAMID)"
```

The identity is used only to sign and verify the candidate as
`ai.opencode.transit`; it is not written to the manifest or repository. Signing
finishes before the transactional replacement begins. This does not weaken or
rewrite existing Keychain access controls.

### Baidu application credentials

Release builds do not embed or provision a shared Baidu OAuth application.
Users connect their own Baidu application from the Sync settings workflow.
Application credentials and OAuth tokens follow RFC-0010 and use the same
OpenCode Auth service as model-provider credentials; they never enter build
manifests, arguments, environment variables, or repository files.

For `mywindows`, copy or build the Linux artifact inside WSL2 and run the installer from the Linux environment. Do not install into or use `/mnt/c/Users/Mickey` as its HOME or workspace.

Fork release automation, artifact provenance, and the fail-closed stable macOS signing gate are documented in [OpenCode Transit releases](transit-release.md).
