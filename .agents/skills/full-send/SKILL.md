---
name: full-send
description: Run the full-stop lifecycle, then merge the PR into main once every gate passes, and confirm the merge and the automatic release it triggers. Only when the user explicitly says "Full Send" for this specific task; installing the skill grants no merge authority. Not for releases, tags, audio/operator deploys or promotions (use promote).
disable-model-invocation: true
---

# Full Send

Full Stop plus an authorized merge. **In this repository, a merge to `main` is a
production release**: `.github/workflows/deploy.yml` ships the bot and portal to
the VPS after main CI passes. "Full Send" on a task authorizes that merge and
the automatic Deploy it triggers. Nothing else is authorized: no tags, GitHub
Releases, operator/audio releases, VPS commands or Deploy re-runs.

## 0. Authorization check

Proceed only if the user's request for **this task** explicitly says Full Send
(or explicitly says to merge it). Earlier tasks, other threads, this file's
existence and repository policy don't count. Otherwise run `full-stop` and stop.

## 1. Build the PR

Run `full-stop` steps 1–6 completely (implementation, tests, `sol-loop`, PR,
`babysit-pr`). If you're taking over an existing PR, start at `babysit-pr` after
evaluating it.

## 2. Gate (every item, on the current head SHA)

```bash
node .agents/skills/babysit-pr/scripts/pr-gate.mjs <n>
```

It must print `READY`. It checks: PR open, not a draft, not from a fork, base is
`main`, no conflicts, branch up to date, no requested changes, no unresolved
conversations, the aggregate `Check` and every other check run green on the head,
and no hold paths changed. You must also confirm:

- The diff is within the scope the user asked for.
- `sol-loop` finished with no open critical or high finding. If no independent
  reviewer could run, stop unless the user explicitly accepted that for this task.
- The PR description's **Deployment** section is accurate. If the change needs
  anything Deploy doesn't do (new env values, audio services, data migration,
  Discord command changes that need extra care), stop and report.

**Hold paths** (`docker-compose*.yml`, `.env*.example`, `lavalink/`, `warp/`, `ops/`,
`.github/workflows/`, agent policy files): pass `--allow-hold-paths` only if the
user's request for this task explicitly approved changing those paths and
merging. Audio changes make Deploy stop for an operator release anyway.

Stop and report on: `BLOCKED`, a repeated `PENDING` that doesn't settle, missing
approvals, unresolved critical findings, an unauthorized base, or any doubt about
merge eligibility or deployment impact. Never use admin privileges, bypasses,
`--admin`, ruleset edits, disabled tests or force-pushes to get past a gate.

## 3. Merge

Merge only through the gate. It evaluates the PR and merges in the same
process, and only on `READY`, pinned to the head SHA it just approved:

```bash
node .agents/skills/babysit-pr/scripts/pr-gate.mjs <n> --merge    # add --allow-hold-paths only if approved
```

- Don't call `gh pr merge` yourself. The gate runs it as
  `--squash --match-head-commit <approved sha>`, so GitHub refuses if the head
  moved. On a refusal or a non-zero exit, re-run step 2.
- The squash commit uses the conventional PR title as its subject
  (repository default).
- Never use `gh pr merge --auto`. It would let a later push merge without this
  gate. While checks are pending, wait (the T3 watcher wakes you) and re-gate.
- If `main` moved: update the branch (`gh pr update-branch <n>` or merge
  `origin/main`), wait for CI on the new head, and re-run the gate.
- Leave branch deletion to GitHub (`delete_branch_on_merge` is on). Don't pass
  `--delete-branch` from a worktree.

## 4. Confirm

```bash
gh pr view <n> --json state,mergedAt,mergeCommit --jq '{state, mergedAt, sha: .mergeCommit.oid}'
gh run list --workflow CI --event push --commit <merge-sha> --json databaseId,status,conclusion,url
gh run watch <ci-run-id> --exit-status
gh run list --workflow Deploy --event workflow_run --commit <merge-sha> --json databaseId,headSha,status,conclusion,url
gh run watch <deploy-run-id> --exit-status
```

Use only runs whose `headSha` is the merge SHA. Never use "the latest" run. A
run can take a minute to appear, so re-list it a few times. If none appears
within 5 minutes, report that instead of choosing another run. Each watch is
bounded by its workflow timeout (CI 20 min per job, Deploy 45 min). Deploy's
final step confirms that both containers carry the merge SHA and report healthy.
That is the live evidence. Report Deploy's own conclusion:

- `success` with "nothing to release": an equal or newer revision was already running.
- `failure` at "Plan the release" on audio files: expected for audio changes. An
  operator release is needed (`promote`).
- `failure` because a session was busy, or any other failure: don't re-run it,
  roll back, or SSH. Report the run URL and the step that failed. The driver's
  journal handles rollback, and the user decides on a re-run.
- `skipped`: main CI failed, so nothing was released. Treat the failure on `main` as urgent.

## 5. Report

PR URL, merge commit SHA, gate result, CI and Deploy run URLs and conclusions,
Sol Loop outcome, and any follow-up needed. Call `unwatch_pull_request` in T3
if a watch is still registered.
