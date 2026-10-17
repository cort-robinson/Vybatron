---
name: babysit-pr
description: Own an open pull request until it is merge-ready, merged, abandoned or genuinely blocked. Links and watches the PR (T3 Code native watcher), reads failing CI logs, fixes real failures, answers and resolves review feedback, and resolves merge conflicts. Use when asked to babysit, watch, monitor or maintain a PR, or as the post-PR phase of Full Stop and Full Send. Never merges; merging belongs to full-send.
---

# Babysit PR

## Start

1. Identify the PR: `gh pr view <n|url|branch> --json number,url,headRefName,baseRefName,state,isDraft`.
   Work in that branch's own worktree. If it isn't yours, use `git worktree list`
   or create one. Never edit another agent's worktree.
2. In T3 Code, call `link_pull_request` with the PR URL, then `watch_pull_request`.
   Only the primary thread may watch. A subagent hands this step back to its parent.
3. Take an initial reading (see Assess), act on it, then **end the turn**. The T3
   watcher wakes this thread when a check fails, required checks pass, someone else
   comments or reviews, or the branch starts to conflict. Do not poll in a loop
   and do not start a background daemon.

Without T3's watcher:
- Claude Code: offer `/loop 10m /babysit-pr <n>` (bounded; stop it when done).
- Codex or plain CLI: wait once with `gh pr checks <n> --watch --fail-fast`
  (blocking, bounded by CI's own timeouts). Handle the result, then hand back with
  the exact resume prompt. Never claim the PR is being monitored when nothing is
  watching it.

## Assess (on every wake)

```bash
node .agents/skills/babysit-pr/scripts/pr-gate.mjs <n>      # verdict + blockers
gh pr checks <n>
gh pr view <n> --comments
gh api repos/{owner}/{repo}/pulls/<n>/comments --jq '.[] | {id, path, line, user: .user.login, body, commit_id, in_reply_to_id}'
```

Only act on what is new: comments and reviews created after your last handled one,
or threads that are still unresolved. Skip feedback that a later commit already
addressed and that you already replied to.

## CI failures

1. Read the real log: `gh run view <run-id> --log-failed` (or `gh run view --job <id> --log`),
   and download artifacts for Playwright failures (`playwright-shard-N`).
2. Find the root cause and classify it:
   - **Product regression**: fix the code and add or adjust a test that catches it.
   - **Test defect**: fix the test so it checks the behavior deterministically. A
     test that needs a longer timeout to pass is suspect.
   - **Flake or infrastructure** (runner outage, registry 5xx, a known timing flake):
     `gh run rerun <run-id> --failed` **once** with the evidence noted. A second
     identical failure counts as real.
3. Reproduce locally with the narrowest command from `AGENTS.md` before pushing.
4. Never weaken a check to make it pass: no skipped tests, relaxed assertions,
   removed jobs, `continue-on-error` or edits to required checks.
5. Limit: 3 fix attempts per distinct failure. After that, report as blocked with
   the logs and hypotheses.

## Review feedback

For each new actionable comment (human or bot):

- Verify it against the source. Fix real problems in a focused commit, then reply
  on the thread with the commit SHA and resolve it.
- Reject false positives with a written, evidence-backed reply. Resolve bot threads
  after replying. Leave a rejected **human** thread unresolved for that person.
- Questions get answers, not code changes.
- Reply to a review thread: `gh api -X POST repos/{owner}/{repo}/pulls/<n>/comments/<id>/replies -f body=...`.
  Resolve it with the GraphQL `resolveReviewThread` mutation, using the thread id
  from `reviewThreads`.
- Scope creep: if the request is reasonable but outside the task, say so and
  suggest a follow-up instead of growing the PR.

Significant code changes made in response to feedback go back through `sol-loop`
(one focused round on the delta) before pushing.

## Merge conflicts and a moving base

```bash
git fetch origin
git merge origin/<base>      # default; rebase only a branch only you have pushed
```

Understand both sides before resolving. Keep valid work from both. Re-run the
verification for every file touched by the conflict. Push normally after a
merge, or with `git push --force-with-lease` after a rebase of your own branch.
Never force-push shared or protected branches. A behind-but-clean branch can be
updated with `gh pr update-branch <n>`. The `main` ruleset requires the branch to
be up to date before merging.

## Finish

Stop and report when one of these is true:

- **Merge-ready**: CI is green, feedback is handled and the Sol Loop is clean.
  Mark a draft ready (`gh pr ready <n>`), then `pr-gate.mjs` must report `READY`
  on the current head. It reports drafts as blocked.
- **Merged or closed**: the watcher ends by itself. Confirm with `gh pr view`.
- **Abandoned or obsolete**: comment why and leave it for the user to close.
- **Blocked**: needs a human approval, product decision, secret, VPS access or
  hold-path approval, or a failure exhausted its attempts.

Before handing back, call `unwatch_pull_request` (T3) unless the user asked you to
keep watching. Report: PR URL, head SHA, gate verdict, checks, what changed and
what (if anything) the user must do.
