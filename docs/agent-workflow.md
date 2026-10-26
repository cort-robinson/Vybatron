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
one production host, so a staging branch would add ceremony without adding a real
environment. Use short-lived branches only.

## Skills

The skills are installed user-wide for Claude Code and Codex: Theo Browne's
[tstack](https://github.com/t3dotgg/tstack) plus `promote` and `setup-repo`.
This repository keeps no copies. A repo copy would shadow the user-wide skill in
Claude Code. The sections below are this repository's rules for those skills,
and they take precedence over a skill's defaults.

| Skill | What it does | Starts automatically? | Merges? |
|---|---|---|---|
| `full-stop` | task → verified, reviewed, merge-ready PR | yes, the default for code changes | never |
| `full-send` | Full Stop, then gated merge to `main` (= automatic release) | no, explicit "Full Send" only | yes, after `pr-gate.mjs` passes |
| `sol-loop` | independent review by another model (Sol preferred) | yes | no |
| `babysit-pr` | link and watch the PR, fix CI, answer review, resolve conflicts | yes | no |
| `promote` | release comparison, checklist and release PR; stops for approval | no, explicit `/promote` or `$promote` only | only when separately approved |

Invoke a skill by name (`/full-stop` in Claude Code, `$full-stop` in Codex or T3)
or just by saying it ("…Full Stop.").

**Full Stop vs Full Send.** Both run the same lifecycle. Full Stop hands you a
merge-ready PR. Full Send also merges it, but only when you said so for that
task, and only if `node scripts/pr-gate.mjs <pr>` prints `READY`. Because a
`main` merge deploys, Full Send then watches CI and Deploy and reports the live
result. It never re-runs Deploy, tags, or touches the production host.

**Sol Loop.** The implementer commits locally, then T3 `delegate_task` sends the
diff to Sol on Codex. A Claude model reviews when Sol wrote the change. The
reviewer can't edit. Tell it to read `AGENTS.md` and the surrounding code, not
just the diff, and to report findings with severity (critical, high, medium,
low) and `file:line`. Resolve every critical and high finding. If no separate
reviewer can run, the summary says so. A self-review is never labeled
independent.

**PR watching.** `babysit-pr` calls `link_pull_request` and `watch_pull_request`,
then ends its turn. T3 wakes the thread on a failed check, passing required
checks, someone else's comment or review, or a new conflict. Only the primary
thread can watch. Outside T3, use the skill's `pr-wait` watcher. There's no
custom daemon.

## Pull requests

- Branch names: `feat/`, `fix/`, `perf/`, `refactor/`, `test/`, `docs/`,
  `chore/`, `ci/` plus a short slug. One task, one branch, one PR.
- Bug fix: write the regression test first and see it fail for the right
  reason, then fix it and see it pass. Record both results.
- Never commit unrelated files, including other agents' changes or untracked
  scratch such as `portal/web/.impeccable/`.
- Open the PR as a draft against `main` while CI and review are pending
  (`gh pr create --draft --base main`), then `gh pr ready <n>` when it is
  merge-ready. The gate reports drafts as blocked.
- Body (keep sections short; write "None" rather than deleting one):

```markdown
## Summary
## Why
## Implementation
## Verification
<commands run and results; for bug fixes, failing-before and passing-after>
### Independent review (Sol Loop)
<reviewer, rounds, findings fixed or rejected, outcome>
## Risks and limitations
## Deployment
<"Merging releases bot+portal automatically via Deploy" | "Touches audio/env/ops: needs operator release (docs/portal-operations.md)" | migrations/config to provision>
```

- CI failures: read the real log (`gh run view <id> --log-failed`; download
  `playwright-shard-N` artifacts for browser failures). Fix product regressions
  with a test, fix test defects deterministically, and re-run a proven
  infrastructure flake once (`gh run rerun <id> --failed`). A second identical
  failure is real. Stop after 3 fix attempts per distinct failure.
- Review: reply to a rejected **human** thread and leave it unresolved for that
  person. Significant changes made for review go back through one focused
  `sol-loop` round on the delta.
- A moving base: `git merge origin/main` (or `gh pr update-branch <n>`), then
  re-run the checks for every file the conflict touched.
- Full Stop ends with: PR URL, head SHA, `pr-gate.mjs` verdict, CI result, Sol
  Loop outcome, verification evidence, risks, and the next step ("say Full Send
  to merge", or the missing approval). A gate block only on hold paths is fine
  for Full Stop. Report it as the approval the user must give.

## Full Send

Run Full Stop completely, then gate and merge.

```bash
node scripts/pr-gate.mjs <n>            # must print READY
node scripts/pr-gate.mjs <n> --merge    # add --allow-hold-paths only if approved
```

The gate checks: PR open, not a draft, not from a fork, base is `main`, no
conflicts, branch up to date, no requested changes, no unresolved conversations,
the aggregate `Check` and every other check run green on the head, and no hold
paths changed. Also confirm the diff is in scope, `sol-loop` finished with no
open critical or high finding (or the user accepted a missing reviewer for this
task), and the PR's **Deployment** section is accurate. Stop and report if the
change needs anything Deploy doesn't do (new env values, audio services, data
migration, risky Discord command changes).

- Pass `--allow-hold-paths` only if the user's request for this task approved
  changing those paths and merging.
- `--merge` runs `gh pr merge --squash --match-head-commit <approved sha>`.
  Never call `gh pr merge` yourself, and never `--auto`. On a refusal, re-gate.
- If `main` moved, update the branch, wait for CI on the new head, and re-gate.
- Leave branch deletion to GitHub (`delete_branch_on_merge` is on).

Confirm, using only runs whose `headSha` is the merge SHA (re-list for up to 5
minutes; never pick "the latest" run):

```bash
gh pr view <n> --json state,mergedAt,mergeCommit --jq '{state, mergedAt, sha: .mergeCommit.oid}'
gh run list --workflow CI --event push --commit <merge-sha> --json databaseId,status,conclusion,url
gh run watch <ci-run-id> --exit-status
gh run list --workflow Deploy --event workflow_run --commit <merge-sha> --json databaseId,headSha,status,conclusion,url
gh run watch <deploy-run-id> --exit-status
```

Deploy's final step confirms both containers carry the merge SHA and are
healthy. Report Deploy's conclusion:

- `success` with "nothing to release": an equal or newer revision was already running.
- `failure` at "Plan the release" on audio files: expected. An operator release
  is needed (`promote`).
- In progress at "Release once nobody is listening": it releases when the bot
  goes idle. Report that it is waiting.
- Any other failure, including 5 busy hours: don't re-run, roll back, or SSH.
  Report the run URL and failed step. The driver's journal handles rollback.
- `skipped`: main CI failed, so nothing was released. Treat it as urgent.

## Releases

`promote` follows this release model.

- `main` is the only long-lived branch. There is no staging branch or
  environment; don't create one.
- **Bot and portal:** every successful `main` CI run deploys automatically
  (`deploy.yml`, gated by `DEPLOY_ENABLED`) using the images CI built and
  tested. Rollback is the portal driver's journal.
- **Audio services** (`docker-compose.yml`, `lavalink/`, `warp/`,
  `ops/PlaybackProbe.java`): Deploy stops on these. They need an operator
  release (`ops/README.md` → *V2 runtime and releases*; `docs/portal-operations.md`).
  `/root/Vybertron` on the production host is updated manually after such merges.
- **Versions:** root `package.json` version → `chore(release): X.Y.Z` PR →
  annotated `vX.Y.Z` tag on its merge commit → GitHub Release. The
  `release tags` ruleset blocks moving or deleting `v*` tags.

Compare (read-only):

```bash
git fetch origin --tags
LAST=$(git describe --tags --abbrev=0 origin/main)
git log --first-parent --format='%h %s' "$LAST"..origin/main
gh pr list --state merged --base main --search "merged:>=$(git log -1 --format=%cs "$LAST")" --json number,title,url
git diff --stat "$LAST"..origin/main
gh run list --workflow Deploy --limit 5 --json headSha,conclusion,url
```

Find the live revision from the latest successful Deploy run (`Verify the
running release` logs both containers' revision label). Don't claim what is
live from repository state alone.

Assess the range: included PRs; persisted data formats (`src/utils/library.js`
`migrateLibrary`, `src/utils/play-stats.js` per ADR-0006, sessions) and whether
the previous release can read data this one writes; new keys in
`.env.example`, `.env.portal.example` and compose files, which must be
provisioned first; audio or infra paths that need an operator release; Discord
command catalog changes (`src/commands`, `deploy-commands.js`); whether the
listening check in `ops/README.md` is needed; and the CI and Deploy runs for
the exact target SHA. The latest successful Deploy may describe an older
revision.

Prepare without extra approval, and change nothing on the production host:

- Versioned release: a `chore/release-X.Y.Z` branch with
  `npm version X.Y.Z --no-git-tag-version`, opened through Full Stop with the
  release summary (semver: breaking → major, features → minor, fixes → patch).
- Operator release: a written plan with the target SHA, images and commands
  from the runbook, idle and maintenance lock requirements, the canaries to
  decode, the rollback command, and the listening check.

Output this checklist:

```markdown
## Promotion: <from> → <to SHA> (<version>)
- Included: <PRs>
- Data/rollback: <…>
- Config to provision: <none | keys>
- Audio/operator release needed: <no | yes: paths>
- CI on target SHA: <url, conclusion>; Deploy: <url, conclusion>
- Approval needed for: <merge release PR | tag + GitHub Release | operator release>
```

Each of these needs its own explicit approval: merging the release PR (it's also
a Deploy, so use the Full Send gate), the tag and Release
(`git tag -a vX.Y.Z <merge-sha> -m "Vybatron X.Y.Z"`, `git push origin vX.Y.Z`,
`gh release create vX.Y.Z --verify-tag`; tag the verified merge commit and never
rebuild), and any production-host action or operator release. An approved operator release
follows the runbook exactly and reports live evidence (revision labels,
`/health`, canary decode results) and any gaps, such as a listening check not
yet done.

## Gates

| Layer | Enforces |
|---|---|
| `main` ruleset (GitHub) | PR required, required checks green, branch up to date (strict), conversations resolved, no force-push, no deletion, merge or squash only, no bypass actors |
| `release tags` ruleset | `v*` tags can't be moved or deleted |
| CI `Check` job | one stable required check that fails if any verification job fails, is cancelled or is unexpectedly skipped |
| `pr-gate.mjs` (agents) | the above on the exact head SHA, plus: base is `main`, not a draft, not a fork, no hold-path changes without explicit approval |
| Deploy | only same-repo `main` pushes with green CI; refuses audio changes and non-ancestor rollbacks; idle-guarded with journal rollback; waits up to 5 h for listeners to finish |

**CI.** `lint` (actionlint, shellcheck, ruff, Lavalink YAML), `test` (JavaScript lint, bot
and driver tests, container build and hardening, compose), `portal` (API, build, OAuth
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
  `node scripts/pr-gate.mjs <n>`. In T3, the
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
