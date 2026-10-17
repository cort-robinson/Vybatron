# Agent workflow

How tasks go from a prompt to a merged, released change with AI agents (T3 Code,
Codex, Claude Code) doing the routine work while GitHub enforces the gates.

## Lifecycle

```text
task ─► worktree + <type>/<slug> branch ─► change + tests ─► local checks
     ─► sol-loop (independent review) ─► draft PR ─► babysit-pr (CI, review, conflicts)
     ─► merge-ready ──[Full Stop ends here]
                    └─[Full Send]─► gated squash merge to main ─► CI ─► Deploy (bot + portal)
releases: promote ─► release summary ─► approval ─► tag / GitHub Release / operator audio release
```

**Branching.** `feature → PR → main`. `main` is the integration branch and the
production line: a successful `main` CI run releases the bot and portal
automatically (`.github/workflows/deploy.yml`). Audio-service changes are the
exception. Deploy stops on them and an operator releases them. One person runs
one VPS, so a staging branch would add ceremony without adding a real
environment. Use short-lived branches only.

## Skills

Canonical definitions live in `.agents/skills/<name>/SKILL.md`. Codex discovers
them there. Claude Code discovers `.claude/skills/<name>/SKILL.md`, a thin entry
point that defers to the canonical file (`npm test` keeps their metadata in
sync). T3 Code lists both through `/` and `$` in the composer. After changing a
skill, run **Restart agent session**.

| Skill | What it does | Starts automatically? | Merges? |
|---|---|---|---|
| `full-stop` | task → verified, reviewed, merge-ready PR | yes, the default for code changes | never |
| `full-send` | Full Stop, then gated merge to `main` (= automatic release) | no, explicit "Full Send" only | yes, after `pr-gate.mjs` passes |
| `sol-loop` | independent review by another model (Sol preferred), up to 3 rounds (5 for serious risks) | yes | no |
| `babysit-pr` | link and watch the PR, fix CI, answer review, resolve conflicts | yes | no |
| `promote` | release comparison, checklist and release PR; stops for approval | no, explicit request only | only when separately approved |

Invoke a skill by name (`/full-stop` in Claude Code, `$full-stop` in Codex or T3)
or just by saying it ("…Full Stop.").

**Full Stop vs Full Send.** Both run the same lifecycle. Full Stop hands you a
merge-ready PR. Full Send also merges it, but only when you said so for that
task, and only if `node .agents/skills/babysit-pr/scripts/pr-gate.mjs <pr>` prints
`READY`. Because a `main` merge deploys, Full Send then watches CI and Deploy and
reports the live result. It never re-runs Deploy, tags, or touches the VPS.

**Sol Loop.** The implementer commits locally, then T3 `delegate_task` sends the
diff to `gpt-6.1-sol` on Codex in an isolated worktree. A Claude model reviews when
Sol wrote the change. The reviewer can't edit. Each finding is fixed, or rejected
with evidence, and the next round re-reviews the delta with the earlier findings
attached. If no separate reviewer can run, the summary says so. A self-review is
never labeled independent.

**PR watching.** `babysit-pr` calls `link_pull_request` and `watch_pull_request`,
then ends its turn. T3 checks every two minutes and wakes the thread on a failed
check, passing required checks, someone else's comment or review, or a new
conflict. It stops on merge or close, after 10 comment-only wakes, or after 8
failed reads. Only the primary thread can watch. Outside T3, use
`/loop 10m /babysit-pr <n>` in Claude Code, or a single
`gh pr checks <n> --watch --fail-fast` and a manual resume. There's no
custom daemon.

## Gates

| Layer | Enforces |
|---|---|
| `main` ruleset (GitHub) | PR required, required checks green, branch up to date (strict), conversations resolved, no force-push, no deletion, merge or squash only, no bypass actors |
| `release tags` ruleset | `v*` tags can't be moved or deleted |
| CI `Check` job | one stable required check that fails if any verification job fails, is cancelled or is unexpectedly skipped |
| `pr-gate.mjs` (agents) | the above on the exact head SHA, plus: base is `main`, not a draft, not a fork, no hold-path changes without explicit approval |
| Deploy | only same-repo `main` pushes with green CI; refuses audio changes and non-ancestor rollbacks; idle-guarded with journal rollback |

**CI.** `lint` (actionlint, shellcheck, ruff, Lavalink YAML), `test` (bot and
driver tests, container build and hardening, compose), `portal` (API, build, OAuth
integration, image, encrypted persistence), `browser (1/3…3/3)` (Playwright), and
the `Check` aggregate. `Dependency audit` runs nightly and on dependency PRs. All
workflows use read-only tokens, and fork PR runs need maintainer approval.

**Merging.** Feature PRs are squash-merged with the PR title as the commit subject.
Merge commits stay allowed for the rare history-preserving case. Merged branches
are deleted automatically. A merge queue isn't available for user-owned
repositories, so the strict up-to-date rule plus `--match-head-commit` stop a
stale green check from authorizing a merge.

## Recovery

- **Inspect an agent-owned PR:** run `gh pr view <n>`, `gh pr checks <n>` and
  `node .agents/skills/babysit-pr/scripts/pr-gate.mjs <n>`. In T3, the
  **Linked pull requests** panel shows the owning thread and its watch.
- **Failed or abandoned task:** the branch and worktree are intact. Resume in the
  same thread ("Continue; babysit PR #n"), or start a takeover. Remove dead
  worktrees with `git worktree remove <path>` after checking `git status`.
- **CI keeps failing:** `babysit-pr` stops after three attempts per failure, or one
  rerun for a proven flake, and reports the logs.
- **Deploy failed after a merge:** read the run. The portal driver rolls back
  through its journal. Re-running Deploy or an operator release needs your call
  (`docs/portal-operations.md`).
- **Concurrent agents:** each has its own worktree and branch. When another PR
  merges first, the strict rule marks yours out of date, and `babysit-pr`
  updates it and re-verifies.

## Prompts

Full Stop:
> Implement this change, verify it, run Sol Loop, open a PR, and babysit CI and review feedback. Full Stop.

Full Send:
> Implement this change, add appropriate tests, run Sol Loop, open a PR, resolve CI and review feedback, and Full Send to the authorized integration branch.

PR takeover:
> Take over this PR. Evaluate the existing implementation, update or replace it as necessary, verify everything, and Full Stop.

The takeover keeps the original author's commits, or credits them with a
`Co-authored-by:` trailer when it replaces their work. For a stale PR, first
decide whether `main` still needs the change, then update it, replace it, or
recommend closing it.

PR maintenance:
> Babysit this PR until it is verified and merge-ready. Resolve legitimate CI and review findings.

Release promotion:
> Prepare the next release promotion. Compare what is live with main, verify compatibility and migrations, create the release PR, and stop for approval.
