# Vybatron agent guide

Discord music bot (`src/`, discord.js + lavalink-client) with a private web portal
(`portal/server` API, `portal/web` React/Vite PWA), audio services (Lavalink, cipher,
WARP via Docker Compose), and Python ops drivers (`ops/`) that run on one VPS.
Node 24, npm, ESM. Read `README.md` (code map), `docs/adr/` and `docs/GLOSSARY.md`
before designing. The repository is public: never commit secrets, hostnames of
private infrastructure, guild or user IDs, or `.env*` values.

## Verify

Run the narrowest checks that cover your change locally. CI runs everything.
On Windows use `npm.cmd` if `npm.ps1` is blocked.

| Change | Command |
|---|---|
| bot `src/`, `tests/*.test.js`, agent skills | `npm test` (or `node --test tests/<file>.test.js`) |
| `ops/`, `tests/*_test.py` | `python -m unittest discover -s tests -p '*_test.py'` |
| `portal/server` | `npm run portal:test` |
| `portal/web` | `npm --prefix portal/web run typecheck`, `npm run portal:build`, then `npx playwright test <spec>` in `portal/web` (build before HTTP specs) |
| portal end-to-end | `npm run portal:integration` (rejects `data:` URLs in built CSS; production CSP) |
| workflows, shell, lint | CI `lint` job: `actionlint`, `shellcheck warp/*.sh tests/*.sh`, `ruff check ops tests` (`pip install -r .github/lint/requirements.txt`) |

Required check: **`Check`**, the CI aggregate (after the setup PR merges, the
`main` ruleset requires it). Never weaken, skip or delete a check to get a pass.

## Workflow

- **Branching:** `<type>/<slug>` branch from `origin/main` → PR → `main`. `main` is
  the only long-lived branch. There's no staging branch; don't create one.
- **Isolation:** one task per worktree and branch. T3 Code threads get their own
  worktree. Otherwise run `git worktree add -b <branch> ../Vybertron-<slug> origin/main`.
  Never edit another agent's worktree, commit unrelated files, or force-push
  shared or protected branches. Use `--force-with-lease` only on your own branch.
- **Commits and PRs:** Conventional Commits, plain language, and one request per PR.
  UI changes include before/after screenshots in the PR, not committed to the repo.
- **Default for code changes: `full-stop`**: an investigated, tested,
  independently reviewed, merge-ready PR. It never merges. Skip the PR only when
  the user asks for investigation or local-only work.
- **`full-send`** only when the user explicitly says "Full Send" (or "merge it")
  for that task. A merge to `main` deploys the bot and portal to production
  automatically, so "Full Send" here authorizes that merge and its Deploy, and
  nothing more.
- **`promote`** for releases (version tags, GitHub Releases, operator audio
  releases). It prepares the release and stops for approval.
- **`sol-loop`** for independent review, and **`babysit-pr`** to own a PR through CI
  and review (T3 `watch_pull_request`). A self-review is never labeled independent.

The skills are installed user-wide (tstack, plus `promote` and `setup-repo`).
This repository keeps no copies. It adds the rules below, which take precedence
over a skill's defaults. The full procedures are in `docs/agent-workflow.md`:
read its *Full Send*, *Releases* or *Pull requests* section before doing that
step.

- **Merge gate:** `node scripts/pr-gate.mjs <n>` must print `READY` before a
  merge, and an agent merges only with `node scripts/pr-gate.mjs <n> --merge`
  (squash, pinned to the approved head). Never `gh pr merge` directly or
  `--auto`. Full Stop reports the gate verdict and doesn't merge.
- **After a Full Send merge:** watch CI and Deploy for the merge SHA and report
  Deploy's conclusion. Never re-run Deploy, roll back or SSH.
- **Pull requests:** open as a draft against `main` while CI and review are
  pending, with the body template from `docs/agent-workflow.md`, then mark ready.
  Update a branch by merging `origin/main`. Rebase only a branch only you pushed.
- **CI failures:** at most 3 fix attempts per distinct failure, and one re-run
  for a proven flake. Then report as blocked with logs.

## Hard limits

- No production action without explicit approval for that action: no SSH or VPS
  commands, Deploy re-runs, tags or releases, secret or variable changes, or
  ruleset or repository-setting edits.
- Approval is required to merge changes to the hold paths: audio services
  (`docker-compose*.yml`, `lavalink/`, `warp/`), `ops/`, `.env*.example`,
  `.github/workflows/`, `.agents/`, `.claude/`, `AGENTS.md`, `CLAUDE.md`,
  `docs/agent-workflow.md` and `scripts/pr-gate.mjs`. `pr-gate.mjs` enforces this.
- Never bypass rulesets (`--admin`, bypass actors, disabling rules). Stop and report
  instead.
- Search and metadata success doesn't prove playback. Audio claims need decoded
  canaries and a listening check (`ops/README.md`).
