# OpenCode Transit security

[English](SECURITY.md) · [简体中文](SECURITY.zh.md)

> [!IMPORTANT]
> OpenCode Transit is an independent project built on [OpenCode](https://github.com/anomalyco/opencode). It is not developed, endorsed, or maintained by the OpenCode team and is not affiliated with them. Reports made here are handled by Transit maintainers, not the OpenCode team.

## Report a vulnerability privately

Use GitHub's private [Report a vulnerability](https://github.com/hammershock/opencode-transit/security/advisories/new) form. Do not open a public issue, discussion, or pull request for an undisclosed vulnerability, and do not include secrets in a public artifact.

The private report should contain:

- affected `opencode-transit --version` output or exact commit;
- controller platform, Location type, and target platform when relevant;
- security impact and the boundary that was crossed;
- minimal, reproducible steps using disposable data;
- sanitized logs, screenshots, or proof-of-concept material;
- any known workaround or disclosure deadline.

Remove access tokens, provider prompts, private hostnames, usernames, personal paths, account identifiers, and real Session content. If a value is essential to reproduction, describe its shape and send the actual value only after a maintainer asks for it inside the private advisory.

Automated or AI-assisted analysis is welcome when the reporter has validated the behavior and can explain a reproducible security impact. Scanner output or a hypothetical weakness without a demonstrated boundary crossing may be closed as non-actionable.

## Supported versions

Transit is under active development and does not yet publish a stable release line.

| Version                                                                   | Security fixes     |
| ------------------------------------------------------------------------- | ------------------ |
| Current `dev` and the latest published Transit prerelease                 | Supported          |
| Older source snapshots, feature branches, or upstream `opencode` binaries | Not supported here |

We may ask you to confirm a report against a current clean build. A vulnerability in unchanged upstream OpenCode may need coordinated handling with the [OpenCode security process](https://github.com/anomalyco/opencode/security); Transit maintainers will make that routing decision without publishing your report.

## Security model

OpenCode Transit is an agent with intentional access to developer tools. It is not a sandbox.

- The agent can read, write, and execute with the permissions of the local account or configured SSH account.
- The permission UI is an interaction and consent boundary, not operating-system isolation.
- A managed Rexd workspace-root boundary limits what Transit exposes through that Location; it does not isolate the remote host account.
- SSH host trust, credentials, network reachability, and operating-system account policy remain the user's responsibility.
- Model providers receive the prompts and data the user sends to them under their own policies.
- User-configured MCP servers, plugins, Skills, shell startup behavior outside Transit, and third-party providers are separate trust boundaries.
- Baidu Session sync does not add application-level end-to-end encryption. Users supply their own Baidu application credentials.
- Server mode must be deliberately exposed and authenticated; an intentionally reachable, user-configured server is not by itself a vulnerability.

Use a container, virtual machine, or restricted operating-system account when untrusted code or data needs isolation.

## What is in scope

Reports are especially useful when they demonstrate a Transit-owned boundary failure, including:

- execution, completion, terminal, or file access occurring on the wrong Location;
- local fallback after a failed remote operation;
- escape from an enforced workspace-root or Skill-resource boundary through Transit;
- SSH host verification or managed Rexd installation accepting the wrong identity or artifact;
- unauthorized disclosure of Auth credentials, environment values, provider tokens, or sync material;
- Session sync exposing another account's data, resurrecting globally deleted data, bypassing device membership, or corrupting integrity checks;
- a read-only Session or trusted command boundary allowing a prohibited mutation or Agent invocation;
- an unauthenticated network surface enabled contrary to the documented default;
- a dependency vulnerability that is reachable through a supported Transit path with meaningful impact.

## What is normally out of scope

The following are not Transit vulnerabilities unless a report shows that our implementation violates its documented boundary:

- the agent performing an action the user explicitly permitted with that operating-system account;
- “sandbox escapes” when no container, VM, or OS sandbox was promised;
- behavior of a user-configured model provider, MCP server, plugin, Skill, SSH server, or Baidu service;
- malicious configuration or project instructions supplied by the same user who runs Transit;
- denial of service that only exhausts the reporting user's local resources and has no persistence or cross-user impact;
- unsupported native Windows, Intel Mac, generic Linux controller, or obsolete source snapshot behavior;
- social engineering, physical access, or attacks requiring prior full control of the same OS account;
- secrets placed by a user into prompts, public logs, repositories, or other destinations outside Transit;
- best-practice suggestions without a reproducible security consequence.

## Coordinated handling

Maintainers will triage reports in the private advisory, confirm the affected boundary, and coordinate a fix and disclosure when needed. Please keep details private until the advisory is published or a maintainer agrees to another disclosure date. We may request permission to share the report confidentially with upstream OpenCode or an affected dependency maintainer.

Fixes follow the project's verification gates, including relevant Mac and WSL2 acceptance. Credit is offered in the advisory unless the reporter prefers to remain anonymous.
