import test from 'node:test';
import assert from 'node:assert/strict';
import { portalFixture, deferred } from './portal-fixtures.js';

const validStamp = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value?.instanceId)
  && Number.isSafeInteger(value?.sequence) && value.sequence > 0;

test('actual bridge stamps post-authorization captures across command and GET, independently of mutation revisions', async t => {
  const f = await portalFixture(t);
  const first = (await f.request()).body;
  const pause = await f.command({ command: 'pause' });
  assert.equal(pause.status, 200);
  const second = pause.body.snapshot;
  const third = (await f.request()).body;
  for (const snapshot of [first, second, third]) assert.ok(validStamp(snapshot.ordering));
  assert.equal(first.ordering.instanceId, second.ordering.instanceId);
  assert.equal(second.ordering.instanceId, third.ordering.instanceId);
  assert.ok(first.ordering.sequence < second.ordering.sequence);
  assert.ok(second.ordering.sequence < third.ordering.sequence);
  assert.equal(second.session.status, 'paused');
  assert.equal(second.revision, third.revision, 'unchanged state retains the conflict hash despite new projection ordering');
});

test('a policy read begun earlier gets its stamp at actual capture after later completed projections', async t => {
  const f = await portalFixture(t);
  const gate = deferred(), entered = deferred();
  const fetch = f.client.users.fetch;
  let held = true;
  f.client.users.fetch = async (...args) => {
    if (held) { held = false; entered.resolve(); await gate.promise; }
    return fetch(...args);
  };
  let slow;
  try {
    slow = f.request(); await entered.promise;
    const fast = await f.request('', { actor: '202' });
    assert.equal(fast.status, 200);
    gate.resolve();
    const later = await slow;
    assert.equal(later.status, 200);
    assert.equal(fast.body.ordering.instanceId, later.body.ordering.instanceId);
    assert.ok(fast.body.ordering.sequence < later.body.ordering.sequence);
  } finally { gate.resolve(); await slow; }
});

test('independent bridge lifetimes cannot produce comparable ordering identities', async t => {
  const first = await portalFixture(t), second = await portalFixture(t);
  const a = (await first.request()).body.ordering, b = (await second.request()).body.ordering;
  assert.ok(validStamp(a)); assert.ok(validStamp(b));
  assert.notEqual(a.instanceId, b.instanceId);
});
