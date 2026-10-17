---
name: promote
description: Prepare a release promotion — a versioned release (version bump PR, tag, GitHub Release) or an operator release of audio/infrastructure changes that automatic Deploy refuses. Compares what is live with main, lists included PRs, checks data, config and audio compatibility, and produces an approval-ready release summary. Stops at the approval boundary; executes only with separate explicit authorization. Use when asked to promote, release, cut a version or ship an operator release.
disable-model-invocation: true
---

# Promote

## Release model

- `main` is the only long-lived branch. There is no staging branch or
  environment; don't create one.
- **Bot and portal:** every successful `main` CI run deploys automatically
  (`deploy.yml`, gated by `DEPLOY_ENABLED`) using the exact images CI built and
  tested. Rollback is the portal driver's journal.
- **Audio services** (`docker-compose.yml`, `lavalink/`, `warp/`,
  `ops/PlaybackProbe.java`): Deploy stops on these. They need an operator
  release (`ops/README.md` → *V2 runtime and releases*; `docs/portal-operations.md`).
  `/root/Vybertron` on the VPS is updated manually after such merges.
- **Versions:** root `package.json` version → `chore(release): X.Y.Z` PR → annotated
  `vX.Y.Z` tag on its merge commit → GitHub Release. The `release tags` ruleset
  blocks moving or deleting `v*` tags.

## 1. Compare (read-only; always allowed)

```bash
git fetch origin --tags
LAST=$(git describe --tags --abbrev=0 origin/main)
git log --first-parent --format='%h %s' "$LAST"..origin/main
gh pr list --state merged --base main --search "merged:>=$(git log -1 --format=%cs "$LAST")" --json number,title,url
git diff --stat "$LAST"..origin/main
gh run list --workflow Deploy --limit 5 --json headSha,conclusion,url
```

Find the live revision from the latest successful Deploy run (`Verify the running
release` logs both containers' revision label). If the user authorized reading
production, use `docker inspect` on the VPS (`docs/portal-operations.md`). Don't
claim what is live from repository state alone.

## 2. Assess

For the range being promoted, report:

- **Included changes:** PRs and commits, grouped as features, fixes, other.
- **Data:** changes to persisted formats, such as `src/utils/library.js`
  (`migrateLibrary`, versioned document), the stats store (`src/utils/play-stats.js`,
  ADR-0006, newer `stats.sqlite` disables stats) and sessions. Can the previous
  release read data written by this one? (Rollback compatibility.)
- **Configuration:** new or changed keys in `.env.example`, `.env.portal.example`
  and compose files. These must be provisioned on the VPS before release.
- **Audio/infra:** any path Deploy refuses. That means an operator release.
- **Discord commands:** catalog changes (`src/commands`, `deploy-commands.js`).
  Registration is global on release.
- **Breaking or operational risk,** and whether the manual listening check
  (`ops/README.md`) is needed.
- **Verification:** CI and Deploy status for `origin/main`'s exact SHA.

## 3. Prepare (allowed without extra approval)

- Versioned release: create a `chore/release-X.Y.Z` branch, run
  `npm version X.Y.Z --no-git-tag-version`, open the PR via `full-stop` with the
  release summary in the body, and draft release notes. Use semver: breaking → major,
  features → minor, fixes → patch.
- Operator release: write the exact plan, including target SHA, images and commands
  from the runbook, idle and maintenance lock requirements, the canaries to
  decode, rollback command and listening check. Change nothing on the VPS.

Output a checklist:

```markdown
## Promotion: <from> → <to SHA> (<version>)
- Included: <PRs>
- Data/rollback: <…>
- Config to provision: <none | keys>
- Audio/operator release needed: <no | yes: paths>
- CI on target SHA: <url, conclusion>; Deploy: <url, conclusion>
- Approval needed for: <merge release PR | tag + GitHub Release | operator release>
```

## 4. Stop for approval

Stop here. Each of these needs its own explicit approval in the current request:
merging the release PR (it's also a Deploy), creating the tag and Release, and
any VPS action. A Full Send on some other task authorizes none of them.

## 5. Execute (only when separately authorized)

- Release PR: merge via `full-send` gates, then confirm CI and Deploy succeeded on
  the merge commit with both containers healthy at that SHA.
- Tag: `git tag -a vX.Y.Z <merge-sha> -m "Vybatron X.Y.Z"`, `git push origin vX.Y.Z`,
  then `gh release create vX.Y.Z --verify-tag --title "…" --notes-file <notes>`.
  Tag the exact verified merge commit and never rebuild for a tag.
- Operator release: follow the runbook exactly, with the user's go-ahead for
  that release. Report live evidence (revision labels, `/health`, canary
  decode results) and name the gaps, such as a listening check not yet done.
