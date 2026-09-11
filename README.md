<p align="center">
  <picture>
    <source srcset="docs/assets/transit-logo-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="docs/assets/transit-logo-light.svg" media="(prefers-color-scheme: light)">
    <img src="docs/assets/transit-logo-light.svg" alt="OpenCode Transit — two connected terminal windows" width="720">
  </picture>
</p>

<p align="center"><strong>Keep the coding session close—even when the workspace is somewhere else.</strong></p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh.md">简体中文</a>
</p>

> [!IMPORTANT]
> OpenCode Transit is an independent project built on [OpenCode](https://github.com/anomalyco/opencode). It is not developed, endorsed, or maintained by the OpenCode team and is not affiliated with them.

<p align="center">
  <a href="https://github.com/hammershock/opencode-transit/actions/workflows/typecheck.yml"><img alt="Typecheck status" src="https://img.shields.io/github/actions/workflow/status/hammershock/opencode-transit/typecheck.yml?branch=dev&style=flat-square&label=typecheck"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-0f766e?style=flat-square"></a>
  <a href="#platform-support"><img alt="Supported controllers: macOS arm64 and WSL2 x64" src="https://img.shields.io/badge/controllers-macOS_arm64_%7C_WSL2_x64-6d28d9?style=flat-square"></a>
  <a href="#feature-status"><img alt="Project status: active development" src="https://img.shields.io/badge/status-active_development-d97706?style=flat-square"></a>
</p>

<p align="center">
  <img src="docs/assets/transit-overview.svg" alt="A Mac or WSL2 controller connects a Session to one explicit local or SSH and Rexd Location; optional Baidu Session sync carries sessions between controllers" width="960">
</p>

OpenCode Transit turns the terminal coding agent into a location-aware workflow. Pick a local workspace or an SSH host once; agent tools, shell completion, terminals, project instructions, and Session recovery stay attached to that explicit Location. Optional Baidu Session sync keeps the conversation available across your own Mac and WSL2 controllers.

## Why Transit

- **One explicit Location, end to end.** QuickStart selects local or SSH, and every workspace-sensitive operation follows the same target and working directory. A remote failure never silently falls back to the controller filesystem.
- **Managed Rexd over SSH.** Transit verifies the SSH host, prepares or reuses a compatible Rexd runtime, and constrains access to the selected workspace root.
- **Sessions remember where they belong.** Location identity is durable. If the target disappears, history remains readable and rebinding is an explicit recovery action.
- **Context you can inspect.** The model receives the actual target platform, project rules, and selected Skills. `/context` shows the frozen context sources for the Session.
- **A TUI built around real terminal work.** Location-aware bash/zsh completion, continuous shell mode, `target · cwd` visibility, trusted command resolution, and one Skill manager for OpenCode, Codex, Claude, and custom Skills.
- **Cross-device Session sync — Beta.** Baidu sync carries complete Sessions and attachments between Mac and WSL2, with an offline outbox and remove-wins deletion. It does not sync workspaces, Git repositories, configuration, targets, credentials, or general UI state.

## Quick start

Transit currently ships from source. The separate `opencode-transit` entrypoint does not overwrite an installed upstream `opencode` command. Install [Bun](https://bun.sh/docs/installation) and Git first, then use the block for your controller.

### macOS Apple Silicon

```bash
git clone https://github.com/hammershock/opencode-transit.git
cd opencode-transit
bun install --frozen-lockfile
cd packages/opencode
bun run script/transit-build.ts --single --skip-install
./script/install-transit \
  --binary dist/opencode-darwin-arm64/bin/opencode-transit \
  --manifest dist/opencode-darwin-arm64/bin/opencode-transit.build.json
opencode-transit
```

### Windows with WSL2 (Ubuntu x64)

Run these commands inside WSL2, not PowerShell or Command Prompt:

```bash
git clone https://github.com/hammershock/opencode-transit.git
cd opencode-transit
bun install --frozen-lockfile
cd packages/opencode
bun run script/transit-build.ts --single --skip-install
./script/install-transit \
  --binary dist/opencode-linux-x64/bin/opencode-transit \
  --manifest dist/opencode-linux-x64/bin/opencode-transit.build.json
opencode-transit
```

Start in a project directory, choose **Local** or an **SSH** target in QuickStart, and continue in the TUI. A few useful commands:

| Command     | Purpose                                                     |
| ----------- | ----------------------------------------------------------- |
| `/target`   | Manage execution targets and test connections               |
| `/context`  | Inspect the target, instructions, and model context sources |
| `/skills`   | Discover and control Skills for local or remote use         |
| `/env list` | Inspect Location-scoped environment sources without values  |
| `/sync`     | Configure or inspect Baidu Session sync                     |

See the [developer entrypoint guide](docs/development/opencode-transit.md) for build metadata, custom install directories, signing, and the `opencode-rexd` compatibility launcher.

## Platform support

| Controller                            | Local workspace                    | SSH + managed Rexd                 | Status                                               |
| ------------------------------------- | ---------------------------------- | ---------------------------------- | ---------------------------------------------------- |
| macOS Apple Silicon (arm64)           | Yes                                | Yes                                | Supported                                            |
| Windows WSL2, Ubuntu x64              | Yes                                | Yes                                | Supported                                            |
| Native Windows                        | No                                 | No                                 | Not supported; use WSL2                              |
| Intel Mac or generic Linux controller | Not in the public support contract | Not in the public support contract | Build paths may exist, but are not release-qualified |

Remote Rexd workspaces may run on compatible Linux or macOS SSH targets. Transit is not a cloud scheduler and Rexd is not a host sandbox.

## Feature status

| Capability                                                    | Status                    | Boundary                                                                     |
| ------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| Local and SSH Locations, managed Rexd                         | Available                 | Requires a reachable, trusted SSH host for remote use                        |
| Location-aware tools, terminal, context, and Session recovery | Available                 | Rebinding a missing Location is explicit                                     |
| Skill manager and structured `$skill` invocation              | Available                 | Skill enablement is device-local; packages are not cloud-synced              |
| Baidu Session sync                                            | **Beta**                  | User-owned Baidu app credentials; no application-level end-to-end encryption |
| Location `.env` sources and shell `cwd` continuity            | **Experimental**          | Opt-in, device-local settings                                                |
| Provider usage in the model footer                            | Available where supported | OpenAI Codex OAuth usage is **Experimental**                                 |

## Know the boundaries

- **Remote access is powerful, not isolated.** The agent can use files and shells permitted by the local account or SSH account. Use a container, VM, or restricted account when you need a security boundary.
- **Workspace-root checks are not a host sandbox.** Managed Rexd constrains the workspace exposed through Transit, but does not turn the remote operating-system account into an isolated tenant.
- **Sync is not end-to-end encrypted by Transit.** Baidu transports stored Session data. Use your own Baidu application credentials and do not treat sync as a secret vault.
- **Transit and upstream OpenCode share internal namespaces.** Configuration and data formats remain closely related; do not assume the two installations are fully isolated just because their executable names differ.
- **Durability has a defined edge.** Admitted inputs and Location binding are durable, but provider work interrupted by a process crash is not automatically retried.

## Documentation and help

- [OpenCode Transit development and installation](docs/development/opencode-transit.md)
- [Release artifacts and provenance](docs/development/transit-release.md)
- [Development workflow](docs/development-workflow.md) and [testing workflow](docs/testing-workflow.md)
- [Architecture RFC index](docs/rfcs/README.md)
- [Issue tracker](https://github.com/hammershock/opencode-transit/issues) for bugs and focused feature requests
- [Upstream OpenCode documentation](https://opencode.ai/docs) for the shared base agent and configuration model

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request. Fork work targets `dev`, uses focused issue-backed branches, and keeps device verification explicit.

## Security

Please report vulnerabilities through the private route in [SECURITY.md](SECURITY.md), not a public issue.

## Upstream and license

Transit exists because of the work of the [OpenCode project](https://github.com/anomalyco/opencode) and its contributors. We retain their copyright and the [MIT License](LICENSE). Fork-specific changes are maintained independently by the OpenCode Transit project.
