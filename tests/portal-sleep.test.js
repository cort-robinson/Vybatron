import test from 'node:test';
import assert from 'node:assert/strict';
import { portalFixture } from './portal-fixtures.js';
import { cancelSleepTimer, sleepTimer } from '../src/utils/sleep-timer.js';

test('the portal sets, shows and cancels a sleep timer through the native command', async t => {
  const f = await portalFixture(t);
  t.after(() => cancelSleepTimer(f.player));
  const before = (await f.request()).body;
  assert.equal(before.session.sleep, null);

  for (const minutes of [0, 721, 1.5, '30']) {
    const invalid = await f.command({ command: 'sleep', subcommand: 'in', options: { minutes } });
    assert.equal(invalid.status, 400, `minutes ${minutes}`);
    assert.equal(invalid.body.error.code, 'invalid_options');
  }
  assert.equal(sleepTimer(f.player), null);

  const started = Date.now();
  const timed = await f.command({ command: 'sleep', subcommand: 'in', options: { minutes: 720 } });
  assert.equal(timed.status, 200);
  assert.equal(timed.body.message, 'Playback will stop in 720 minutes.');
  assert.equal(timed.body.snapshot.session.sleep.mode, 'time');
  assert.ok(timed.body.snapshot.session.sleep.endsAt >= started + 720 * 60_000);
  assert.notEqual(timed.body.snapshot.revision, before.revision, 'a timer change wakes portal clients');

  const show = await f.command({ command: 'sleep', subcommand: 'show' });
  assert.equal(show.status, 200);
  assert.equal(show.body.message, 'Sleep timer: Stops in 720 minutes.');

  const afterTrack = await f.command({ command: 'sleep', subcommand: 'after-track' });
  assert.deepEqual(afterTrack.body.snapshot.session.sleep, { mode: 'track' });

  const cancelled = await f.command({ command: 'sleep', subcommand: 'cancel' });
  assert.equal(cancelled.body.message, 'Sleep timer cancelled.');
  assert.equal(cancelled.body.snapshot.session.sleep, null);
});

test('portal sleep controls follow Stop’s DJ-role, voice and visibility rules', async t => {
  const f = await portalFixture(t);
  t.after(() => cancelSleepTimer(f.player));
  await f.library.updateGuild('100', guild => { guild.settings.djRoleId = '500'; });
  const listener = await f.command({ command: 'sleep', subcommand: 'after-track' });
  assert.equal(listener.status, 403);
  assert.equal(sleepTimer(f.player), null);

  f.members.get('200').roles.cache.set('500', {});
  f.members.get('200').voice.channel = f.channels.get('301');
  assert.equal((await f.command({ command: 'sleep', subcommand: 'after-track' })).status, 403, 'another voice channel');
  f.members.get('200').voice.channel = f.channels.get('300');
  assert.equal((await f.command({ command: 'sleep', subcommand: 'after-track' })).status, 200);

  f.channels.get('300').hidden.add('202');
  const hidden = (await f.request('', { actor: '202' })).body;
  assert.equal(hidden.session.sleep, null, 'a hidden session hides its timer');
  assert.equal((await f.command({ command: 'sleep', subcommand: 'show' }, { actor: '202' })).status, 403);
});
