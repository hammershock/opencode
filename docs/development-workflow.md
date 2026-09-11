# Fork Development Workflow

This document defines how this fork turns accepted RFCs into maintainable work when multiple people or Agents develop in parallel. It supplements the upstream `AGENTS.md` and `CONTRIBUTING.md`; package-local `AGENTS.md` files still apply to files below their directories.

User-facing README, contribution, security, release and visual documentation follows [the human-facing documentation standard](development/human-documentation.md). Its [Simplified Chinese version](development/human-documentation.zh.md) is maintained alongside the English canonical document.

## Principles

1. Plan by behavior and contract, not by package or developer.
2. One task has one reviewable outcome, one owner at a time, one branch, one worktree, and one PR.
3. Accepted RFCs define product and architecture decisions. Tasks may refine implementation details but cannot silently change an RFC decision.
4. Keep upstream behavior behind explicit adapters, decorators, or compatibility tests. Avoid broad rewrites that make upstream synchronization harder.
5. The branch graph expresses real dependencies. Independent features start from `dev`; stacked branches are exceptional and explicit.
6. Names describe the change. Developer names, Agent names, machine names, and dates do not belong in branches or worktree paths.

## Sources of truth

Use these artifacts for distinct purposes:

| Artifact            | Owns                                                                        | Does not own                               |
| ------------------- | --------------------------------------------------------------------------- | ------------------------------------------ |
| RFC in `docs/rfcs`  | Accepted behavior, boundaries, risks, compatibility and acceptance criteria | Daily progress or implementation ownership |
| GitHub issue        | One task contract, owner, dependencies, status and handoff notes            | Long-lived architecture decisions          |
| Branch and worktree | Isolated implementation for exactly one issue                               | Planning for unrelated work                |
| Pull request        | Review, verification evidence and integration into `dev`                    | Unapproved product decisions               |

Do not create a second task tracker in repository Markdown. GitHub issues are the live task queue; RFCs and merged PRs are the durable record. A PR must close exactly one primary issue. It may reference related issues without closing them.

## Task types

- **Foundation:** a schema, interface, migration or shared service required by later tasks.
- **Vertical feature:** the smallest end-to-end user-visible or domain-visible behavior that can be accepted independently.
- **Compatibility patch:** a narrowly specified upstream override or adapter change.
- **Bug fix:** a reproducible defect with no new product scope.
- **Spike:** time-boxed investigation whose output is evidence or a proposed task split. Spike code is not merged as production code unless converted into a normal task and reviewed.
- **Upstream sync:** an isolated integration of `upstream/dev`, containing no new fork feature work.

Do not create tasks such as “implement RFC-0002” when the RFC crosses several contracts and clients. Split it into foundation and vertical tasks connected by explicit dependencies. Conversely, do not split a coherent change merely because it touches multiple packages.

## Task contract

An implementation issue is **Ready** only when it contains:

- a short outcome stated in observable terms;
- the governing RFC and exact section, or `Not RFC-governed` with a reason;
- in-scope and out-of-scope behavior;
- dependencies expressed as issue links;
- affected contracts and likely code areas, without treating that list as a directory restriction;
- compatibility and migration requirements;
- acceptance checks, including failure behavior;
- the minimum test and manual verification plan;
- the applicable Mac and `mywindows` real-device scenarios from `docs/testing-workflow.md`;
- known security, credential, remote-execution, sync, or data-loss risks;
- whether generated API/SDK artifacts are expected.

Use this compact issue body:

```md
## Outcome

## Governing RFC

## In scope

## Out of scope

## Dependencies

## Contracts and likely areas

## Acceptance checks

## Verification

## Risks and compatibility
```

If implementation reveals a missing product decision, stop that part of the task and amend or add an RFC. Do not hide the decision in code, test fixtures, or a PR comment.

## Task sizing and dependency graph

A good task can be reviewed as one semantic change and normally has one primary failure domain. Prefer these boundaries:

- contract before consumers;
- provider-neutral service before provider adapters;
- domain workflow before TUI command or panel;
- compatibility fixture before an upstream override;
- one provider adapter or one built-in override per task;
- generated artifacts in the same PR as the public contract that requires them, but in a distinct commit when useful for review.

Independent tasks branch directly from the latest accepted `dev`. If task B needs unmerged code from task A, mark B `Blocked by #A`. Only start B as a stacked task when parallel work materially helps and the shared interface in A is stable.

A stacked PR must:

- declare its base PR and dependency in the issue and PR;
- contain no duplicate commits from an unrelated branch;
- target the dependency branch while that dependency is open, then retarget `dev` after it merges;
- be rebased or otherwise updated so review shows only B's delta;
- never form an undocumented chain. Chains deeper than two open PRs require an explicit maintainer decision.

When three or more tasks need the same unfinished code, extract the shared contract into a foundation task instead of building a long feature stack.

## Ownership and multi-Agent coordination

- An issue has one active owner. Other Agents may review, research or test, but must not concurrently edit its branch or worktree.
- Claim work in the GitHub issue before editing. Record the branch name and base commit in the claim comment.
- One Agent may own multiple issues only when they do not share an active worktree and dependencies remain explicit.
- Never use an Agent identity in committed source, issue-required filenames, branch names, worktree names, commit subjects or public API names.
- Before changing a shared contract, search open issues and PRs for consumers. Notify affected task owners through issue/PR links.
- If two tasks begin editing the same contract, pause one task and choose one owner for the contract. The other task consumes the merged contract or becomes an explicitly stacked PR.
- A handoff comment must state current outcome, remaining work, decisions made, failing checks, base/head commits and uncommitted files. The receiving owner verifies the worktree before continuing.
- Agents do not “helpfully” commit, reset, clean or rebase another task's worktree. Read-only inspection is allowed.

## Worktree layout

The canonical primary checkout is:

```text
~/workspace/opencode
```

Dedicated worktrees live as siblings under:

```text
~/workspace/opencode-worktrees/<branch>
```

The primary checkout is reserved for:

- RFC and workflow maintenance;
- upstream synchronization;
- release/integration verification;
- creating, inspecting and retiring worktrees.

Feature, patch and bug implementation occurs in a dedicated worktree. This keeps an Agent from changing branches underneath another Agent and prevents unrelated uncommitted files from leaking into a task.

## Branch and worktree lifecycle

Branch names follow the root `AGENTS.md`: at most three lowercase words separated by hyphens, with no slash or type prefix. Use a durable semantic name such as `rexd-handshake`, `target-recovery`, or `usage-openai`.

Before creating work, update refs and confirm the issue is Ready:

```bash
cd ~/workspace/opencode
git fetch origin
git fetch upstream
git worktree list
git branch --list <branch>
```

Create an independent task from local `dev` after it has been fast-forwarded or otherwise intentionally synchronized with `origin/dev`:

```bash
mkdir -p ~/workspace/opencode-worktrees
git worktree add ~/workspace/opencode-worktrees/<branch> -b <branch> dev
```

If the branch already exists, attach it without `-b`:

```bash
git worktree add ~/workspace/opencode-worktrees/<branch> <branch>
```

For an approved stacked task, replace `dev` in the creation command with the dependency branch and record that base in the issue. Never guess a base from whichever branch the primary checkout currently has checked out.

After creation, verify isolation before editing:

```bash
git -C ~/workspace/opencode-worktrees/<branch> status --short --branch
git worktree list
```

Rules while working:

- one worktree contains one checked-out task branch;
- never attach the same branch to two worktrees;
- do not switch a task worktree to an unrelated branch;
- do not copy source files between worktrees; move changes through commits and declared Git ancestry;
- do not use the primary checkout as a scratch area or dependency cache for a task;
- untracked artifacts belong to the task and must be removed, ignored or intentionally committed before handoff;
- never use `git reset --hard`, destructive clean commands or forced branch deletion as routine cleanup.

After the PR is merged, first verify that the worktree is clean and that its commits are reachable from the intended integration history. Then retire it with Git's worktree command rather than deleting its directory manually:

```bash
git -C ~/workspace/opencode-worktrees/<branch> status --short
git branch --merged dev
git worktree remove ~/workspace/opencode-worktrees/<branch>
git worktree prune
```

Delete the local branch only after the merge is verified and no worktree uses it. Never force-remove a dirty worktree. If untracked or unmerged work exists, preserve it and resolve ownership before cleanup.

## Commit and PR discipline

- Follow the conventional commit rules in root `AGENTS.md`.
- Each commit represents one reviewable intent: contract, implementation, tests, migration or generated output.
- Do not mix opportunistic refactors, formatting churn, upstream synchronization or unrelated dependency updates into a feature commit.
- Fixup commits are acceptable during review; fold them before merge when they only repair an earlier commit and retain them when they document a distinct decision.
- A PR title is the task's release-level summary and follows `type(scope): summary`.
- PR descriptions stay concise and include the issue, RFC section, user-visible outcome, important compatibility notes, verification commands/results and UI evidence when applicable.
- Default to a merge commit for a non-trivial multi-commit feature so its task boundary remains visible in the graph. Squash a trivial one-commit-equivalent change when retaining internal commits adds no value.
- Do not cherry-pick an entire completed feature into `dev`; merge its reviewed branch. Cherry-picks are reserved for deliberate backports and must cite the source PR.

## Verification and completion

A task is **Done** only when:

- every acceptance check in the issue is satisfied;
- relevant package-local tests and `bun typecheck` pass from the correct package directories;
- compatibility/failure-path tests required by the RFC pass;
- relevant real-device acceptance passes on both the Mac and `mywindows` under the exact built commit;
- generated files were produced by repository scripts and are consistent;
- UI changes include before/after screenshots or recordings;
- no secrets, external login state, machine-specific paths or credentials entered the diff, fixtures or logs;
- the PR contains no unrelated changes and documents any intentionally deferred work;
- the governing RFC's `implemented-by` field is updated only when the merged PR actually implements a complete tracked portion, using PR links rather than developer names.

Test failures that predate the task must be reproduced on the declared base and documented. They are not silently ignored and are not repaired in the task unless the issue scope is expanded explicitly.

## Upstream synchronization

Upstream integration is its own task and worktree. It must not carry feature implementation.

- Fetch `upstream/dev` and merge it through a dedicated semantic branch such as `upstream-sync`.
- Never rebase the shared published `dev` branch onto upstream.
- Resolve conflicts at the adapter/override boundary and run static upstream compatibility checks from RFC-0003 and RFC-0006.
- If an accepted override contract drifted, update its fixture and obtain RFC review before changing behavior.
- Record upstream base commit, conflict decisions and verification in the sync PR.
- Feature branches created before the sync remain based on their declared commit; update them deliberately after the sync rather than mutating every worktree automatically.

## Maintainer checklist before assigning parallel work

1. Is the governing RFC accepted?
2. Is each issue independently observable and reviewable?
3. Are shared contracts extracted and owned once?
4. Are issue dependencies a DAG rather than an implicit branch chain?
5. Does every active issue have a unique semantic branch and worktree?
6. Are high-risk migrations, credentials, remote execution and deletion rules represented in acceptance tests?
7. Can each task merge without enabling an incomplete feature, using an experimental setting where the RFC requires one?

The detailed test ladder, evidence requirements, device matrix, and release gate are defined in [`testing-workflow.md`](testing-workflow.md).
Fork-owned TUI surfaces additionally follow the normative interaction and presentation rules in [`ui-design-guidelines.md`](ui-design-guidelines.md).
