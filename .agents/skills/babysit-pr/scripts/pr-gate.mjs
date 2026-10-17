#!/usr/bin/env node
// Reports whether a pull request may be merged by an agent, from live GitHub state.
//
//   node .agents/skills/babysit-pr/scripts/pr-gate.mjs <pr> [--allow-hold-paths] [--json]
//
// Exit 0: ready. Exit 2: pending (checks running or mergeability not computed yet).
// Exit 1: blocked. GitHub rulesets enforce the same basics server-side; this gate adds
// the repository's agent policy (authorized base, hold paths, the aggregate Check).
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const POLICY = {
  // Branches an explicitly requested Full Send may merge into. Merging to main
  // triggers the automatic bot and portal release (.github/workflows/deploy.yml).
  integrationBranches: ['main'],
  requiredCheck: 'Check',
  // Changes here need the user's explicit approval of these paths before an agent
  // merges: audio services and new environment values need an operator on the VPS,
  // and the pipeline, release drivers and agent policy govern their own enforcement.
  holdPaths: [
    'docker-compose.yml',
    'docker-compose.portal.yml',
    '.env.example',
    '.env.portal.example',
    'lavalink/',
    'warp/',
    'ops/',
    '.github/workflows/',
    '.agents/',
    '.claude/',
    'AGENTS.md',
    'CLAUDE.md',
  ],
  // Runbook prose under ops/ is documentation, not a driver.
  holdExempt: [/^ops\/.*\.md$/],
};

const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);

export function heldFiles(files, { holdPaths, holdExempt } = POLICY) {
  return files.filter((file) => !holdExempt.some((exempt) => exempt.test(file))
    && holdPaths.some((hold) => (hold.endsWith('/') ? file.startsWith(hold) : file === hold)));
}

// Reruns leave several runs with one name; the newest one counts.
export function latestRuns(checkRuns) {
  const byName = new Map();
  for (const run of checkRuns) {
    const seen = byName.get(run.name);
    if (!seen || run.id > seen.id) byName.set(run.name, run);
  }
  return [...byName.values()];
}

export function evaluate(state, { allowHoldPaths = false, policy = POLICY } = {}) {
  const { pr, checkRuns, behindBy, unresolvedThreads } = state;
  const blockers = [];
  const pending = [];

  if (pr.state !== 'OPEN') blockers.push(`PR is ${pr.state.toLowerCase()}`);
  if (pr.isDraft) blockers.push('PR is a draft');
  if (pr.isCrossRepository) blockers.push('PR comes from a fork; a maintainer merges it');
  if (!policy.integrationBranches.includes(pr.baseRefName)) {
    blockers.push(`base ${pr.baseRefName} is not an authorized integration branch (${policy.integrationBranches.join(', ')})`);
  }
  if (pr.mergeable === 'CONFLICTING') blockers.push('merge conflicts with the base branch');
  if (pr.mergeable === 'UNKNOWN') pending.push('GitHub has not computed mergeability yet');
  if (behindBy > 0) blockers.push(`head is ${behindBy} commit(s) behind ${pr.baseRefName}; update the branch and re-verify`);
  if (pr.reviewDecision === 'CHANGES_REQUESTED') blockers.push('a reviewer requested changes');
  if (unresolvedThreads > 0) blockers.push(`${unresolvedThreads} unresolved review conversation(s)`);

  const runs = latestRuns(checkRuns);
  const required = runs.find((run) => run.name === policy.requiredCheck);
  if (!required) pending.push(`required check ${policy.requiredCheck} has not reported on ${pr.headRefOid.slice(0, 7)}`);
  for (const run of runs) {
    if (run.status !== 'completed') pending.push(`${run.name} is ${run.status}`);
    else if (FAILED.has(run.conclusion)) blockers.push(`${run.name} concluded ${run.conclusion}`);
  }

  const held = heldFiles(pr.files, policy);
  if (held.length && !allowHoldPaths) {
    blockers.push(`changes hold paths that need explicit approval: ${held.join(', ')}`);
  }

  const verdict = blockers.length ? 'blocked' : pending.length ? 'pending' : 'ready';
  return { verdict, headSha: pr.headRefOid, base: pr.baseRefName, blockers, pending, held };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 << 20 });
}

function jsonLines(text) {
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export function collect(number) {
  const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
  const [owner, name] = repo.split('/');
  const fields = 'number,url,state,isDraft,isCrossRepository,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision';
  const pr = JSON.parse(gh(['pr', 'view', String(number), '--repo', repo, '--json', fields]));
  pr.files = jsonLines(gh(['api', '--paginate', `repos/${repo}/pulls/${pr.number}/files?per_page=100`,
    '--jq', '.[] | [.filename, .previous_filename] | map(select(. != null)) | .[] | tojson'])).flat();
  const checkRuns = jsonLines(gh(['api', '--paginate', `repos/${repo}/commits/${pr.headRefOid}/check-runs?per_page=100`,
    '--jq', '.check_runs[] | {id, name, status, conclusion} | tojson']));
  const behindBy = Number(gh(['api', `repos/${repo}/compare/${encodeURIComponent(pr.baseRefName)}...${pr.headRefOid}`, '--jq', '.behind_by']).trim());
  const threads = JSON.parse(gh(['api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${pr.number}`, '-f',
    'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}']));
  const unresolvedThreads = threads.data.repository.pullRequest.reviewThreads.nodes.filter((thread) => !thread.isResolved).length;
  return { repo, pr, checkRuns, behindBy, unresolvedThreads };
}

function main(argv) {
  const number = argv.find((arg) => /^\d+$/.test(arg));
  if (!number) {
    console.error('usage: pr-gate.mjs <pr-number> [--allow-hold-paths] [--json]');
    return 1;
  }
  const state = collect(number);
  const result = { pr: state.pr.url, ...evaluate(state, { allowHoldPaths: argv.includes('--allow-hold-paths') }) };
  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${result.verdict.toUpperCase()} ${result.pr} @ ${result.headSha.slice(0, 7)} -> ${result.base}`);
    for (const item of result.blockers) console.log(`  blocked: ${item}`);
    for (const item of result.pending) console.log(`  pending: ${item}`);
  }
  return { ready: 0, pending: 2, blocked: 1 }[result.verdict];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
