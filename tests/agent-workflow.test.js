import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evaluate, heldFiles, latestRuns } from '../.agents/skills/babysit-pr/scripts/pr-gate.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const SKILLS = ['babysit-pr', 'full-send', 'full-stop', 'promote', 'sol-loop'];
const EXPLICIT_ONLY = ['full-send', 'promote'];

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, '\n'));
  assert.ok(match, 'SKILL.md starts with a frontmatter block');
  const fields = Object.fromEntries(match[1].split('\n').map((line) => {
    const at = line.indexOf(':');
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
  return { raw: match[0], fields, body: text.slice(match[0].length) };
}

function state({ pr = {}, checkRuns, behindBy = 0, unresolvedThreads = 0 } = {}) {
  return {
    pr: {
      state: 'OPEN', isDraft: false, isCrossRepository: false, baseRefName: 'main',
      headRefOid: 'a'.repeat(40), mergeable: 'MERGEABLE', reviewDecision: '', files: ['src/index.js'], ...pr,
    },
    checkRuns: checkRuns ?? [
      { id: 1, name: 'test', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'Check', status: 'completed', conclusion: 'success' },
    ],
    behindBy,
    unresolvedThreads,
  };
}

test('every skill has valid shared metadata and a Claude Code entry point', () => {
  assert.deepEqual(readdirSync(new URL('.agents/skills/', root)).sort(), SKILLS);
  for (const name of SKILLS) {
    const canonical = frontmatter(read(`.agents/skills/${name}/SKILL.md`));
    assert.equal(canonical.fields.name, name);
    assert.match(name, /^[a-z0-9-]{1,64}$/);
    assert.ok(canonical.fields.description.length > 40 && canonical.fields.description.length <= 1024, `${name} description length`);
    assert.ok(canonical.body.trim().length > 200, `${name} has instructions`);

    const entry = frontmatter(read(`.claude/skills/${name}/SKILL.md`));
    assert.equal(entry.raw, canonical.raw, `${name}: Claude entry point metadata matches the canonical skill`);
    assert.ok(entry.body.includes(`.agents/skills/${name}/SKILL.md`), `${name}: entry point defers to the canonical file`);
  }
});

test('merging and releasing skills only start on an explicit request', () => {
  for (const name of SKILLS) {
    const { fields } = frontmatter(read(`.agents/skills/${name}/SKILL.md`));
    const codexPolicy = existsSync(new URL(`.agents/skills/${name}/agents/openai.yaml`, root))
      ? read(`.agents/skills/${name}/agents/openai.yaml`) : '';
    const explicit = EXPLICIT_ONLY.includes(name);
    assert.equal(fields['disable-model-invocation'] === 'true', explicit, `${name}: Claude implicit invocation`);
    assert.equal(/allow_implicit_invocation:\s*false/.test(codexPolicy), explicit, `${name}: Codex implicit invocation`);
  }
  assert.doesNotMatch(read('.agents/skills/full-stop/SKILL.md'), /gh pr merge/);
});

test('documented verification commands exist', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  for (const name of ['test', 'portal:test', 'portal:build', 'portal:integration']) assert.ok(scripts[name], name);
  assert.ok(JSON.parse(read('portal/web/package.json')).scripts.typecheck);
  assert.match(read('.github/workflows/ci.yml'), /\n {2}check:\n {4}name: Check\n {4}if: always\(\)/);
});

test('gate passes a clean, current, green pull request', () => {
  assert.deepEqual(evaluate(state()).verdict, 'ready');
});

test('gate blocks unsafe merges', () => {
  const cases = [
    [{ pr: { isDraft: true } }, /draft/],
    [{ pr: { isCrossRepository: true } }, /fork/],
    [{ pr: { baseRefName: 'release' } }, /not an authorized integration branch/],
    [{ pr: { mergeable: 'CONFLICTING' } }, /merge conflicts/],
    [{ pr: { reviewDecision: 'CHANGES_REQUESTED' } }, /requested changes/],
    [{ pr: { state: 'MERGED' } }, /merged/],
    [{ behindBy: 2 }, /2 commit\(s\) behind main/],
    [{ unresolvedThreads: 1 }, /unresolved review conversation/],
    [{ checkRuns: [{ id: 1, name: 'Check', status: 'completed', conclusion: 'failure' }] }, /Check concluded failure/],
    [{ checkRuns: [{ id: 1, name: 'Check', status: 'completed', conclusion: 'success' }, { id: 2, name: 'audit', status: 'completed', conclusion: 'cancelled' }] }, /audit concluded cancelled/],
    [{ pr: { files: ['lavalink/application.yml'] } }, /hold paths.*lavalink\/application\.yml/],
  ];
  for (const [input, reason] of cases) {
    const result = evaluate(state(input));
    assert.equal(result.verdict, 'blocked', String(reason));
    assert.match(result.blockers.join('\n'), reason);
  }
});

test('gate waits for missing or running checks instead of passing them', () => {
  const missing = evaluate(state({ checkRuns: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }] }));
  assert.equal(missing.verdict, 'pending');
  assert.match(missing.pending[0], /Check has not reported/);
  const running = evaluate(state({ checkRuns: [{ id: 1, name: 'Check', status: 'in_progress', conclusion: null }] }));
  assert.equal(running.verdict, 'pending');
  assert.equal(evaluate(state({ pr: { mergeable: 'UNKNOWN' } })).verdict, 'pending');
});

test('gate judges the newest run of each check', () => {
  const runs = [
    { id: 5, name: 'Check', status: 'completed', conclusion: 'failure' },
    { id: 9, name: 'Check', status: 'completed', conclusion: 'success' },
  ];
  assert.deepEqual(latestRuns(runs), [runs[1]]);
  assert.equal(evaluate(state({ checkRuns: runs })).verdict, 'ready');
  assert.equal(evaluate(state({ checkRuns: [...runs].reverse().map((run, i) => ({ ...run, id: i })) })).verdict, 'blocked');
});

test('hold paths match whole files and directory prefixes only', () => {
  assert.deepEqual(heldFiles(['ops/deploy.py', 'docker-compose.yml', 'docs/ops/x.md', 'src/ops/y.js', 'AGENTS.md.bak', 'ops/README.md']),
    ['ops/deploy.py', 'docker-compose.yml']);
  assert.equal(evaluate(state({ pr: { files: ['ops/deploy.py'] } }), { allowHoldPaths: true }).verdict, 'ready');
});
