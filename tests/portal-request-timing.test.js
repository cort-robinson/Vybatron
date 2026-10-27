import test from 'node:test';
import assert from 'node:assert/strict';
import { discordTime, measureDiscord, serverTiming, startRequestTiming } from '../src/portal/request-timing.js';
import { portalFixture } from './portal-fixtures.js';

const metrics = /^bot;dur=\d+\.\d, discord;dur=\d+\.\d$/;

test('bridge timing counts overlapping Discord reads once and reports only fixed metrics', async () => {
  let now = 0; const response = {};
  const timed = startRequestTiming(response, () => now);
  const slow = ms => async () => { await null; now += ms; return 'context'; };
  await timed(async () => {
    now += 2;
    // Two authorization reads in flight together: wall time, not the sum.
    await Promise.all([discordTime(slow(5)), discordTime(slow(3))]);
    now += 1;
    assert.equal(await measureDiscord({ guild: slow(4), identity: slow(1), close() {} }).guild('actor', 'guild'), 'context');
  });
  assert.equal(serverTiming(response), 'bot;dur=15.0, discord;dur=12.0');
  // No request timing in scope: plain pass-through, nothing recorded anywhere.
  assert.equal(await discordTime(async () => 'outside'), 'outside');
  assert.equal(serverTiming({}), null);
});

test('private bridge replies carry Server-Timing without identifiers, including errors', async t => {
  const f = await portalFixture(t);
  const get = path => fetch(`${f.origin}${path}`, { headers: { Authorization: `Bearer ${f.token}` } });
  for (const path of ['/v1/bootstrap?actorId=200', '/v1/guilds/100?actorId=200', '/v1/guilds/100/library?actorId=200']) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    const timing = response.headers.get('server-timing');
    // The exact format admits only fixed names and numbers: no IDs or content.
    assert.match(timing, metrics, path);
  }
  const command = await fetch(`${f.origin}/v1/guilds/100/commands`, { method: 'POST',
    headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ actorId: '200', command: 'pause' }) });
  assert.equal(command.status, 200); assert.match(command.headers.get('server-timing'), metrics);
  const denied = await get('/v1/guilds/100?actorId=999');
  assert.notEqual(denied.status, 200); assert.match(denied.headers.get('server-timing'), metrics);
});
