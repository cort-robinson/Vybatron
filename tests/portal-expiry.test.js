import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { portalFixture, deferred } from './portal-fixtures.js';
import { createPortalPolicy } from '../src/portal/policy.js';
import { createRevisions } from '../src/portal/projection.js';
import { executePortalCommand } from '../src/portal/commands.js';
import { loadCommandsData } from '../src/commands/index.js';
import { withGuildMutation } from '../src/utils/requests.js';
import { track } from './fixtures.js';

async function harness(t, options) {
  const f = await portalFixture(t, options);
  const policy = createPortalPolicy(f.client); t.after(() => policy.close());
  const revisions = createRevisions(f.client); t.after(() => revisions.close());
  const commands = new Map(await loadCommandsData());
  return { ...f, run: (body, signal) => executePortalCommand(f.client, policy, revisions, commands, '100', { actorId: '200', ...body }, { signal }) };
}

const added = f => f.calls.filter(call => call === 'add' || call === 'splice').length;

test('a portal request that expires while queued behind the guild lane never enqueues', async t => {
  const f = await harness(t);
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const lane = withGuildMutation('100', async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const expiry = new AbortController();
  const pending = f.run({ command: 'play', options: { query: 'queued song' } }, expiry.signal);
  const denied = assert.rejects(pending, { status: 503 });
  await delay(10);
  expiry.abort();
  release.resolve(); await Promise.all([lane, denied]);
  assert.equal(added(f), 0);

  await f.run({ command: 'play', options: { query: 'queued song' } }, new AbortController().signal);
  assert.equal(added(f), 1, 'an unexpired request still enqueues');
});

test('a portal request that expires during a slow search ignores the late result', async t => {
  const searching = deferred(), result = deferred();
  const f = await harness(t, { search: () => { searching.resolve(); return result.promise; } });
  const expiry = new AbortController();
  const pending = f.run({ command: 'play', options: { query: 'slow song' } }, expiry.signal);
  const denied = assert.rejects(pending, { status: 503 });
  await searching.promise;
  expiry.abort();
  result.resolve({ loadType: 'track', tracks: [track('lateresult1')] });
  await denied;
  assert.equal(added(f), 0);
  assert.ok(!f.player.queue.tracks.some(item => item.info.identifier === 'lateresult1'));
});
