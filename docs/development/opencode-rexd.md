# `opencode-rexd` development entrypoint

Fork builds keep OpenCode's internal package identity and produce a separate executable named `opencode-rexd`. They never install over the upstream `opencode` executable.

## Build

From `packages/opencode`, build the current platform with:

```bash
bun run script/rexd-build.ts --single --skip-install
```

The artifact is written below `dist/opencode-<platform>/bin/` as:

- `opencode-rexd` — the executable;
- `opencode-rexd.build.json` — commit, version, dirty-worktree flag, and build time.

The version contains the source commit, for example `1.18.29-rexd.0123456789ab`. A `.dirty` suffix identifies builds made with uncommitted source changes. Acceptance builds must be made from a clean accepted commit.

## Install

Install the artifact on macOS or Linux/WSL without changing an existing `opencode` command:

```bash
./script/install-rexd \
  --binary dist/opencode-darwin-arm64/bin/opencode-rexd \
  --manifest dist/opencode-darwin-arm64/bin/opencode-rexd.build.json
```

The default destination is the existing fork entrypoint at `~/.local/bin/opencode-rexd`. Override it with `--install-dir` or `OPENCODE_REXD_INSTALL_DIR`. The installer does not edit shell startup files and never writes `~/.local/bin/opencode`.

The installer validates the candidate and then directly replaces the existing
`opencode-rexd` entrypoint. It does not retain or support an old-build
compatibility copy or rollback entrypoint. Rexd connection configuration and
user data are outside the build artifact and are not modified by installation.

### Provision the Baidu product OAuth application

Production release operators may provision the product-owned Baidu OAuth
application while installing a validated candidate:

```bash
credential-producer | ./script/install-rexd \
  --binary dist/opencode-darwin-arm64/bin/opencode-rexd \
  --manifest dist/opencode-darwin-arm64/bin/opencode-rexd.build.json \
  --provision-baidu-app
```

`credential-producer` must emit one bounded JSON object with exactly the
`appKey` and `secretKey` string fields. Use an approved CI or release secret
resolver that writes directly to stdout. Do not place the JSON in an argument,
environment variable, repository file, manifest, or temporary file.

The installer first validates the candidate, then passes stdin to a hidden
deployment entrypoint. The candidate writes the exact
`opencode-rexd-sync` / `baidu:app` platform secure-store record and reads it
back. A failed write or verification restores the previous record and leaves
the installed executable unchanged. Output and errors never include the
credential. This is a release/deployment operation: the normal CLI help and
TUI do not offer product OAuth application credential entry. A build without
the record tells users to reinstall an official build or contact its
distributor.

For `mywindows`, copy or build the Linux artifact inside WSL2 and run the installer from the Linux environment. Do not install into or use `/mnt/c/Users/Mickey` as its HOME or workspace.
