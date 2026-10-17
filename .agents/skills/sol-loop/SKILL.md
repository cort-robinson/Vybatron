---
name: sol-loop
description: Get an independent review of the current change from a separate reviewer agent (Sol preferred), fix valid findings, rebut invalid ones with evidence, and re-review until no significant findings remain. Use after implementing a change and before opening or updating its PR, or when asked for a Sol Loop or independent review. Not for reviewing someone else's PR without a change of our own.
---

# Sol Loop

Independent review of our own change, iterated to a clean result. The implementing
agent never reviews itself and calls it independent.

## 1. Prepare the review target

1. Commit the work locally (a WIP commit is fine; it can be squashed later). The
   reviewer reads commits, not your uncommitted files.
2. Record `BASE=$(git merge-base origin/main HEAD)` and `HEAD_SHA=$(git rev-parse HEAD)`.
3. Write down the task, its acceptance criteria and the verification you ran.

## 2. Choose the reviewer (first available wins)

| Order | Reviewer | How | Label in summary |
|---|---|---|---|
| 1 | Sol on Codex: `gpt-6.1-sol`, reasoning `high` | T3 `delegate_task` with `target.providerInstanceId` from `orchestrator_capabilities`, `isolation: "worktree"` | `independent (cross-model: Sol)` |
| 2 | Another provider's strongest model, used when Sol is unavailable or Sol implemented the change | same `delegate_task` call with that model | `independent (cross-model: <model>)` |
| 3 | Other provider's CLI headless, read-only: `codex exec --sandbox read-only "<prompt>"` or `claude -p "<prompt>"` | Bash, in a clean worktree at `HEAD_SHA` | `independent (cross-model: <model>, CLI)` |
| 4 | A fresh-context subagent of your own provider (Claude Code `Agent`, Codex subagent) | native subagent tool | `isolated (same model, fresh context)` |

Call `orchestrator_capabilities` to discover T3 provider and model IDs instead of
guessing them. If none of these can run, stop. Report "independent review
unavailable" and the reason. Do not substitute a self-review.

## 3. Review prompt

Each round is a new task with a distinct `clientRequestId` (`sol-loop-<branch>-r<N>`).
Do not continue a reviewer's child thread. Give the reviewer:

- The repository and that it must not edit files, commit, push or comment on GitHub.
- Task and acceptance criteria, plus `git diff BASE...HEAD_SHA` and `git log BASE..HEAD_SHA`.
  Tell it to read surrounding code and `AGENTS.md`, not just the diff.
- For rounds 2+: every earlier finding, how it was resolved (commit) or why it was
  rejected (evidence), and any objections still open.
- What to look for: correctness, regressions, missing or mirror-only tests, security
  and authorization, data loss, concurrency, deployment impact, unnecessary complexity.
- Output: findings only, each with `severity` (critical | high | medium | low),
  `file:line`, the problem, why it matters (a concrete failing scenario), and a
  suggested fix. Say "no findings" when there are none; do not pad.

## 4. Triage every finding

For each finding, decide **valid**, **partly valid** or **rejected**:

- Reproduce or reason it through against the code; reviewers can be wrong.
- Fix valid findings with the smallest correct change and a test where it fits.
- Reject with evidence: a test, a line reference or a documented invariant.
  "I disagree" is not evidence.
- Do not apply suggestions you can't justify, and do not invent findings to show
  that work happened.

Re-run the affected verification and commit the fixes before the next round.

## 5. Stop rules

- Stop when a round returns no new critical or high findings and every medium
  finding is fixed or rejected with evidence.
- Normal limit: 3 rounds. Go to round 4 or 5 only while a critical or high finding
  about security, authorization, data loss or correctness is still disputed or unfixed.
- After the limit, list what is still unresolved as a risk. Don't loop further.

## 6. Output

Return this block. Full Stop pastes it into the PR description:

```markdown
### Independent review (Sol Loop)
- Reviewer: <model> via <T3 delegate_task | CLI | subagent>; label: <independent (cross-model …) | isolated (same model …)>
- Rounds: <n> (head <short sha>)
- Findings: <n total> — fixed <n>, rejected <n>, open <n>
  - [high] path:line — problem → fixed in <sha> | rejected: <evidence>
- Unresolved risks: <none | list>
- Outcome: <clean | clean with accepted risks | blocked: reason>
```
