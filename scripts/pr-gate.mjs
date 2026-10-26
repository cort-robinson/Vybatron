#!/usr/bin/env node
// Reports whether a pull request may be merged by an agent, from live GitHub state.
//
//   node scripts/pr-gate.mjs <pr> [--allow-hold-paths] [--json] [--merge]
//
// --merge (full-send only) squash-merges in the same process, and only on READY,
// pinned to the head SHA this run approved.
// Exit 0: ready. Exit 2: pending (checks running or mergeability not computed yet).
// Exit 1: blocked. GitHub rulesets enforce the same basics server-side; this gate adds
// the repository's agent policy (authorized base, hold paths, the aggregate Check).
// A READY verdict covers only the reported headSha: merge with --match-head-commit.
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
    /^docker-compose[^/]*\.ya?ml$/,
    /^\.env[^/]*\.example$/,
    /^lavalink\//,
    /^warp\//,
    /^ops\/(?!.*\.md$)/, // runbook prose under ops/ is documentation, not a driver
    /^\.github\/workflows\//,
    /^\.agents\//,
    /^\.claude\//,
    /^scripts\/pr-gate\.mjs$/,
    /^docs\/agent-workflow\.md$/,
    /^(AGENTS|CLAUDE)\.md$/,
  ],
};

const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);

export function heldFiles(files, holdPaths = POLICY.holdPaths) {
  return files.filter((file) => holdPaths.some((hold) => hold.test(file)));
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
  const { pr, checkRuns, workflowRuns = [], statuses = [], behindBy, unresolvedThreads } = state;
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

  // A re-run keeps the previous attempt's green check runs until new ones exist,
  // so an unfinished workflow run on the head means its results are not final.
  for (const run of workflowRuns) {
    if (run.status !== 'completed') pending.push(`workflow ${run.name} is ${run.status} on this head`);
  }

  const runs = latestRuns(checkRuns);
  const required = runs.find((run) => run.name === policy.requiredCheck);
  const short = pr.headRefOid.slice(0, 7);
  if (!required) pending.push(`required check ${policy.requiredCheck} has not reported on ${short}`);
  else if (required.status === 'completed' && required.conclusion !== 'success') {
    // Skipped or neutral would satisfy GitHub; it does not satisfy this gate.
    blockers.push(`required check ${policy.requiredCheck} concluded ${required.conclusion}, not success`);
  }
  for (const run of runs) {
    if (run.status !== 'completed') pending.push(`${run.name} is ${run.status}`);
    else if (run !== required && FAILED.has(run.conclusion)) blockers.push(`${run.name} concluded ${run.conclusion}`);
  }
  for (const status of statuses) {
    if (status.state === 'pending') pending.push(`status ${status.context} is pending`);
    else if (status.state !== 'success') blockers.push(`status ${status.context} is ${status.state}`);
  }

  const held = heldFiles(pr.files, policy.holdPaths);
  if (held.length && !allowHoldPaths) {
    blockers.push(`changes hold paths that need explicit approval: ${held.join(', ')}`);
  }

  // GitHub's own verdict catches rules this gate does not model.
  if (!blockers.length && !pending.length && ['BLOCKED', 'DIRTY', 'BEHIND'].includes(pr.mergeStateStatus)) {
    blockers.push(`GitHub reports merge state ${pr.mergeStateStatus}`);
  }

  const verdict = blockers.length ? 'blocked' : pending.length ? 'pending' : 'ready';
  return { verdict, headSha: pr.headRefOid, base: pr.baseRefName, blockers, pending, held };
}

function runGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 << 20 });
}

function jsonLines(text) {
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    reviewThreads(first:100,after:$after){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}`;

export function countUnresolvedThreads(gh, owner, name, number) {
  let unresolved = 0;
  let after = null;
  do {
    const args = ['api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`, '-f', `query=${THREADS_QUERY}`];
    if (after) args.push('-f', `after=${after}`);
    const page = JSON.parse(gh(args)).data.repository.pullRequest.reviewThreads;
    unresolved += page.nodes.filter((thread) => !thread.isResolved).length;
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return unresolved;
}

export function collect(number, gh = runGh) {
  const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
  const [owner, name] = repo.split('/');
  const fields = 'number,url,state,isDraft,isCrossRepository,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision';
  const pr = JSON.parse(gh(['pr', 'view', String(number), '--repo', repo, '--json', fields]));
  const sha = pr.headRefOid;
  pr.files = jsonLines(gh(['api', '--paginate', `repos/${repo}/pulls/${pr.number}/files?per_page=100`,
    '--jq', '.[] | [.filename, .previous_filename] | map(select(. != null)) | .[] | tojson']));
  const checkRuns = jsonLines(gh(['api', '--paginate', `repos/${repo}/commits/${sha}/check-runs?per_page=100`,
    '--jq', '.check_runs[] | {id, name, status, conclusion} | tojson']));
  const workflowRuns = jsonLines(gh(['api', '--paginate', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`,
    '--jq', '.workflow_runs[] | {name, status} | tojson']));
  const statuses = jsonLines(gh(['api', '--paginate', `repos/${repo}/commits/${sha}/status?per_page=100`,
    '--jq', '.statuses[] | {context, state} | tojson']));
  const behindBy = Number(gh(['api', `repos/${repo}/compare/${encodeURIComponent(pr.baseRefName)}...${sha}`, '--jq', '.behind_by']).trim());
  const unresolvedThreads = countUnresolvedThreads(gh, owner, name, pr.number);
  return { repo, pr, checkRuns, workflowRuns, statuses, behindBy, unresolvedThreads };
}

// Never merges unless the verdict is ready; the SHA comes from the same evaluation.
export function mergeIfReady(result, number, gh = runGh) {
  if (result.verdict !== 'ready' || !/^[0-9a-f]{40}$/.test(result.headSha)) return false;
  gh(['pr', 'merge', String(number), '--squash', '--match-head-commit', result.headSha]);
  return true;
}

function main(argv) {
  const number = argv.find((arg) => /^\d+$/.test(arg));
  if (!number) {
    console.error('usage: pr-gate.mjs <pr-number> [--allow-hold-paths] [--json] [--merge]');
    return 1;
  }
  const state = collect(number);
  const result = { pr: state.pr.url, ...evaluate(state, { allowHoldPaths: argv.includes('--allow-hold-paths') }) };
  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${result.verdict.toUpperCase()} ${result.pr} @ ${result.headSha} -> ${result.base}`);
    for (const item of result.blockers) console.log(`  blocked: ${item}`);
    for (const item of result.pending) console.log(`  pending: ${item}`);
  }
  if (argv.includes('--merge')) {
    if (!mergeIfReady(result, number)) {
      console.error('not merged: the gate did not report READY');
      return result.verdict === 'pending' ? 2 : 1;
    }
    console.log(`merged ${result.pr} at ${result.headSha}`);
  }
  return { ready: 0, pending: 2, blocked: 1 }[result.verdict];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
