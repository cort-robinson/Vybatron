---
name: full-stop
description: Take a development task from investigation to a verified, independently reviewed, merge-ready pull request — and stop there. Isolated worktree, smallest correct change, tests, local verification, sol-loop, PR, then babysit-pr until CI and review are clean. Never merges, releases or deploys. Default lifecycle for code-change tasks in this repository, and what "Full Stop" requests.
---

# Full Stop

Task in, merge-ready PR out. **Never merge, tag, release, deploy or touch the VPS.**
Those need `full-send` or `promote` and their own explicit authorization.

## 1. Understand

- Restate the task and acceptance criteria. Make routine technical decisions
  yourself. Ask only when a missing answer would change the result, or when the
  work needs authorization you don't have (production, secrets, hold paths in
  `AGENTS.md`).
- Read the relevant code, tests, ADRs (`docs/adr`) and `docs/GLOSSARY.md` before
  designing. Trace the full data path, and reuse behavior that already exists.
- `git fetch origin` and check open PRs (`gh pr list`) for overlapping work.

## 2. Isolate

- T3 Code threads usually start in their own worktree under `~/.t3/worktrees`.
  Check with `git rev-parse --show-toplevel` and `git status`.
- Otherwise: `git worktree add -b <type>/<slug> ../Vybertron-<slug> origin/main`.
- Branch names: `feat/`, `fix/`, `perf/`, `refactor/`, `test/`, `docs/`, `chore/`, `ci/`
  plus a short slug. One task, one branch, one PR.
- Never commit unrelated files, including other agents' changes or untracked
  scratch such as `portal/web/.impeccable/`.

## 3. Implement and test

- Make the smallest change that fully solves the task, with no drive-by refactors.
- **Bug fix:** write the regression test first and see it fail for the right
  reason, then fix it and see it pass. Record both results.
- **Feature:** add behavioral tests at the level the behavior lives (unit
  `tests/`, API `portal/server/test`, browser `portal/web/tests`). Avoid tests that
  only mirror the implementation.
- Run the narrowest relevant checks from `AGENTS.md` → *Verify*. CI runs the full suite.

## 4. Review

Run `sol-loop` on the committed change. Resolve every critical and high finding,
and keep its summary block.

## 5. Publish

1. Use Conventional Commits (`type(scope): summary`), and split commits where
   that makes review easier.
2. `git fetch origin && git merge origin/main` if main moved, re-run the affected
   checks, then `git push -u origin HEAD`.
3. Open the PR against `main` (the only integration branch). Open it as a draft
   while CI and review are pending:

```bash
gh pr create --draft --base main --title "<conventional title>" --body-file <file>
```

PR body (keep sections short; write "None" rather than deleting one):

```markdown
## Summary
## Why
## Implementation
## Verification
<commands run and results; for bug fixes, failing-before and passing-after>
### Independent review (Sol Loop)
<block from sol-loop>
## Risks and limitations
## Deployment
<"Merging releases bot+portal automatically via Deploy" | "Touches audio/env/ops: needs operator release (docs/portal-operations.md)" | migrations/config to provision>
```

4. In T3 Code, call `link_pull_request` with the PR URL.

## 6. Babysit

Run `babysit-pr` until the PR is merge-ready (marked ready for review, and the gate
reports `READY`) or genuinely blocked. A gate block only on hold paths is fine for
Full Stop: report it as the approval the user must give before any merge.

## 7. Report and stop

Return: PR URL, head SHA, `pr-gate.mjs` verdict, CI result, Sol Loop outcome,
verification evidence, remaining risks, and the user's next step ("say Full Send
to merge", or what approval is missing). Do not merge.
