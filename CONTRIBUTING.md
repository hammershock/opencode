# Contributing to OpenCode Transit

[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh.md)

Thank you for helping improve OpenCode Transit. Focused bug fixes, documentation, tests, compatibility work, and well-scoped product improvements are welcome.

> [!IMPORTANT]
> OpenCode Transit is an independent project built on [OpenCode](https://github.com/anomalyco/opencode). It is not developed, endorsed, or maintained by the OpenCode team and is not affiliated with them.

## Start with an issue

Every pull request must close one issue in [this repository](https://github.com/hammershock/opencode-transit/issues). Before writing code:

1. Search open and closed issues for the same problem.
2. Open the matching [bug report](https://github.com/hammershock/opencode-transit/issues/new?template=bug-report.yml), [feature request](https://github.com/hammershock/opencode-transit/issues/new?template=feature-request.yml), or [question](https://github.com/hammershock/opencode-transit/issues/new?template=question.yml).
3. Describe one observable outcome, relevant boundaries, and how it could be verified.
4. Wait for a maintainer to confirm the scope before implementing a product feature. Comment before taking an issue so work is not duplicated.

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md) instead.

Features that change a durable product or architecture contract need an accepted RFC before implementation. Maintainers will say when that applies; a bug fix or documentation correction normally does not need a new RFC.

### Choose the right repository

Use this repository for Transit-specific behavior: Locations, SSH/Rexd, Session placement and recovery, sync, provider usage, fork-owned TUI commands, Skills, release entrypoints, and their integration with upstream OpenCode.

If a problem reproduces unchanged in upstream OpenCode and does not involve a Transit boundary, first search the [upstream issue tracker](https://github.com/anomalyco/opencode/issues). Do not cross-post the same report. Clearly disclose the relationship when an upstream change is also relevant here.

## Set up a worktree

You need Git and the Bun version declared in the root [`package.json`](package.json). Fork the repository on GitHub, clone your fork, and add this project as a remote:

```bash
git clone https://github.com/YOUR-GITHUB-LOGIN/opencode-transit.git
cd opencode-transit
git remote add transit https://github.com/hammershock/opencode-transit.git
```

Create a dedicated worktree from the latest `dev`. Branch names use at most three short words separated by hyphens, without type prefixes such as `feat/` or personal names.

```bash
git fetch transit dev
git worktree add ../opencode-transit-fix-example -b fix-example transit/dev
cd ../opencode-transit-fix-example
bun install --frozen-lockfile
```

Replace `fix-example` with your semantic branch name.

One issue maps to one branch, one worktree, and one pull request. Do not mix refactors, dependency updates, generated churn, or upstream synchronization into an unrelated change. The full repository workflow is in [`docs/development-workflow.md`](docs/development-workflow.md).

## Develop the change

Run Transit against a disposable project directory with:

```bash
bun dev /path/to/disposable/project
```

Follow the root [`AGENTS.md`](AGENTS.md) and any package-local `AGENTS.md` that applies to files you edit. In particular:

- keep changes small and preserve upstream behavior outside the accepted Transit boundary;
- use Bun APIs and precise inferred types where they fit;
- avoid import aliases, star imports, unnecessary destructuring, `any`, reassignment, and broad `try`/`catch` blocks;
- never include credentials, private hostnames, personal paths, account identifiers, or production Session content;
- add comments for surprising constraints, not obvious control flow.

When a public API changes, regenerate its owned output instead of editing generated files:

- legacy JavaScript SDK: `./packages/sdk/js/script/build.ts`
- Protocol or Server `HttpApi`: run `bun run generate` from `packages/client`

## Verify what you changed

Run the narrowest relevant checks first. Tests cannot run from the repository root, and TypeScript packages use `bun typecheck` rather than direct `tsc`.

```bash
# Example: package typecheck and one focused test
cd packages/opencode
bun typecheck
bun test path/to/affected.test.ts
```

| Change                                            | Contributor evidence                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Documentation or templates                        | Formatting, local links/anchors, rendered Markdown or form validation                                |
| TypeScript logic                                  | Affected package `bun typecheck` and focused unit/contract/integration tests                         |
| TUI behavior                                      | Focused checks plus a screenshot or recording from an available supported controller                 |
| Location, Rexd, shell, environment, auth, or sync | Focused automated checks and the relevant real workflow on every supported controller you can access |
| Generated API or SDK                              | Generator command, generated diff review, and affected package checks                                |

Use sanitized temporary workspaces, Sessions, target labels, and test accounts. Never put credential values or decrypted sync payloads in logs or screenshots. UI evidence should show before and after when applicable.

The detailed test ladder and acceptance rows live in [`docs/testing-workflow.md`](docs/testing-workflow.md).

### Device responsibility

External contributors are not expected to own both canonical project devices. Run the relevant workflow on the supported platform you can access and list, without guessing, every platform or scenario you did not run. Missing device coverage does not prevent you from opening a pull request.

For a functional change, maintainers complete the required Mac Apple Silicon and `mywindows`/WSL2 acceptance on the exact candidate commit before merge. This is a project merge gate, not a requirement that contributors buy, borrow, or administer project hardware. Documentation-only changes normally do not require runtime device acceptance.

## Open the pull request

Open the pull request against [`hammershock/opencode-transit:dev`](https://github.com/hammershock/opencode-transit/tree/dev), not `main` or upstream OpenCode.

- Use `Closes #123` for exactly one primary issue.
- Use a conventional title such as `fix(tui): preserve remote completion state` or `docs: clarify WSL2 setup`.
- Explain the outcome, the reason the change works, compatibility or security boundaries, and concise verification results.
- Select the platforms you ran and explicitly list gaps.
- Attach screenshots or recordings for user-visible TUI changes.
- Keep commits reviewable; maintainers may squash a one-commit-equivalent change.

Whether the work was written manually or with automated assistance, you are responsible for understanding the change, checking its claims, and answering review questions. Generated volume is not evidence; a concise, reproducible explanation is.

## Review and completion

Review may request a smaller scope, new regression coverage, an RFC decision, generated artifacts, or maintainer-run device evidence. A pull request is ready to merge only when:

- its issue and acceptance checks are satisfied;
- relevant automated checks pass;
- contributor and maintainer verification gaps are resolved or explicitly not applicable;
- generated files are current;
- no secrets or private machine data appear in the diff or evidence;
- user-facing English and Simplified Chinese documents remain in semantic sync.

If issue or pull-request automation flags missing required information, update the existing item within seven days. Automation evaluates completeness and reproducibility; it does not reject work merely because tools assisted the author.

Maintainers own final integration, cross-device acceptance, and release qualification. Contributors retain authorship credit for accepted work.
