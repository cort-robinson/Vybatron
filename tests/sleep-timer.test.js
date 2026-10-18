import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { data, execute, sleepStop } from '../src/commands/sleep.js';
import { clearIdleTimer, handlePlayerDestroy, startIdleTimer } from '../src/lavalink.js';
import { buildPlayerPayload } from '../src/utils/messages.js';
import { commandMutationPolicy } from '../src/utils/requests.js';
import {
  cancelSleepTimer, claimFinishedTrack, setSleepTimer, sleepTimer, sleepTimerText, validSleepMinutes,
} from '../src/utils/sleep-timer.js';
import { track } from './fixtures.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

function fakePlayer(overrides = {}) {
  const data = new Map();
  const calls = [];
  const player = {
    guildId: '100', voiceChannelId: '300', textChannelId: '400', paused: false, volume: 100, repeatMode: 'off',
    queue: { current: track(), tracks: [track('lmnopqrstuv')], previous: [] },
    getData: key => data.get(key), setData: (key, value) => data.set(key, value),
    async stopPlaying(clearQueue, autoplay) { calls.push(['stopPlaying', clearQueue, autoplay]); if (clearQueue) this.queue.tracks.length = 0; },
    async destroy(reason) { calls.push(['destroy', reason]); },
    calls,
    ...overrides,
  };
  return player;
}

function fakeClient(player, { djRoleId = null } = {}) {
  const sessions = [];
  const notices = [];
  const ended = [];
  return {
    sessions, notices, ended,
    lavalink: { getPlayer: () => player },
    library: {
      settings: () => ({ djRoleId }),
      async updateGuild(_id, edit) { const guild = { session: { tracks: [] } }; edit(guild); sessions.push(guild.session); },
    },
    playTracker: { ended: (_player, reason) => ended.push(reason) },
    channels: { cache: new Map([['400', { async send(payload) { notices.push(payload); } }]]) },
  };
}

function request(client, action, { minutes = null, inVoice = true, roles = [] } = {}) {
  const replies = [];
  return {
    client, commandName: 'sleep', guildId: '100', guild: { id: '100', ownerId: 'owner' }, deferred: false, replied: false,
    user: { id: '200', username: 'Listener' },
    member: { voice: { channel: inVoice ? { id: '300' } : null }, roles: { cache: new Map(roles.map(id => [id, {}])) } },
    memberPermissions: { has: () => false },
    options: { getSubcommand: () => action, getInteger: () => minutes },
    replies,
    async reply(payload) { this.replied = true; replies.push(payload.content); },
  };
}

test('/sleep exposes in, after-track, cancel and show with a 1–720 minute bound', () => {
  const json = data.toJSON();
  assert.deepEqual(json.options.map(option => option.name), ['in', 'after-track', 'cancel', 'show']);
  const minutes = json.options[0].options[0];
  assert.equal(minutes.required, true);
  assert.equal(minutes.min_value, 1);
  assert.equal(minutes.max_value, 720);
  assert.deepEqual(commandMutationPolicy('sleep', 'show'), { readOnly: true, playback: true, urgent: false });
  assert.equal(commandMutationPolicy('sleep', 'in').readOnly, false);
});

test('sleep minutes reject values outside 1–720 and non-integers', () => {
  for (const minutes of [1, 720]) assert.equal(validSleepMinutes(minutes), true);
  for (const minutes of [0, 721, 1.5, -1, Number.NaN, '5', null]) {
    assert.equal(validSleepMinutes(minutes), false);
    assert.throws(() => setSleepTimer({}, { minutes, onFire() {} }), RangeError);
  }
});

test('a timed sleep fires once at its deadline and not a millisecond before', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const player = {};
  const fired = [];
  setSleepTimer(player, { minutes: 1, onFire: (target, mode) => fired.push([target, mode]) });
  assert.deepEqual(sleepTimer(player), { mode: 'time', endsAt: 1_060_000 });
  assert.equal(sleepTimerText(sleepTimer(player), 1_000_000), 'Stops in 1 minute.');
  t.mock.timers.tick(59_999);
  await flush();
  assert.equal(fired.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(fired, [[player, 'time']]);
  assert.equal(sleepTimer(player), null);
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(fired.length, 1);
});

test('the 720 minute maximum schedules a 12 hour timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const player = {};
  let fired = 0;
  setSleepTimer(player, { minutes: 720, onFire: () => { fired++; } });
  assert.equal(sleepTimerText(sleepTimer(player), 0), 'Stops in 720 minutes.');
  t.mock.timers.tick(720 * 60_000 - 1);
  await flush();
  assert.equal(fired, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(fired, 1);
});

test('cancel and replacement clear the earlier deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const player = {};
  const fired = [];
  setSleepTimer(player, { minutes: 1, onFire: (_target, mode) => fired.push(mode) });
  assert.equal(cancelSleepTimer(player), true);
  assert.equal(cancelSleepTimer(player), false);
  setSleepTimer(player, { minutes: 1, onFire: (_target, mode) => fired.push(mode) });
  setSleepTimer(player, { afterTrack: true, onFire: (_target, mode) => fired.push(mode) });
  t.mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(fired, [], 'after-track replaced the timed sleep');
  assert.deepEqual(sleepTimer(player), { mode: 'track' });
  assert.equal(claimFinishedTrack(player), true);
  await flush();
  assert.deepEqual(fired, ['track']);
  assert.equal(claimFinishedTrack(player), false, 'it fires once');
});

test('a timed sleep never claims a finished track', () => {
  const player = {};
  setSleepTimer(player, { minutes: 5, onFire() {} });
  assert.equal(claimFinishedTrack(player), false);
  cancelSleepTimer(player);
});

test('destroying the player discards its sleep timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const player = { guildId: '100' };
  let fired = 0;
  setSleepTimer(player, { minutes: 1, onFire: () => { fired++; } });
  // A replacement session owns the guild, so only the lifecycle cleanup runs.
  handlePlayerDestroy({ lavalink: { getPlayer: () => ({}) } }, player);
  assert.equal(sleepTimer(player), null);
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(fired, 0);
});

test('an idle or empty-channel disconnect cancels the sleep timer before it awaits anything', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const player = fakePlayer();
  const client = { lavalink: { getPlayer: () => player } };
  let fired = 0;
  setSleepTimer(player, { minutes: 1, onFire: () => { fired++; } });
  t.after(() => { clearIdleTimer(player.guildId); cancelSleepTimer(player); });
  startIdleTimer(player, { ms: 59_000, reason: 'voice-empty', client });
  t.mock.timers.tick(59_000);
  // The disconnect has started but has not reached destroy() yet.
  assert.equal(sleepTimer(player), null);
  t.mock.timers.tick(1_000);
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(fired, 0);
  assert.deepEqual(player.calls.filter(([name]) => name === 'stopPlaying'), []);
});

test('/sleep follows Stop’s voice-channel and DJ-role checks', async () => {
  const player = fakePlayer();
  const client = fakeClient(player, { djRoleId: '999' });
  const outside = request(client, 'in', { minutes: 30, inVoice: false, roles: ['999'] });
  await execute(outside);
  assert.match(outside.replies[0], /Join a voice channel/);
  const listener = request(client, 'in', { minutes: 30 });
  await execute(listener);
  assert.match(listener.replies[0], /reserved for this server’s DJ role/);
  const elsewhere = request(client, 'after-track', { roles: ['999'] });
  elsewhere.member.voice.channel = { id: '301' };
  await execute(elsewhere);
  assert.match(elsewhere.replies[0], /Join the bot’s voice channel/);
  assert.equal(sleepTimer(player), null);

  const dj = request(client, 'in', { minutes: 30, roles: ['999'] });
  await execute(dj);
  assert.equal(dj.replies[0], 'Playback will stop in 30 minutes.');
  assert.equal(sleepTimer(player).mode, 'time');
  // Show is read-only: any listener who can see the session may check it.
  const show = request(client, 'show', { inVoice: false });
  show.guild.channels = { cache: new Map(['300', '400'].map(id => [id, { guildId: '100', permissionsFor: () => ({ has: () => true }) }])) };
  await execute(show);
  assert.equal(show.replies[0], 'Sleep timer: Stops in 30 minutes.');
  const cancel = request(client, 'cancel', { roles: ['999'] });
  await execute(cancel);
  assert.equal(cancel.replies[0], 'Sleep timer cancelled.');
  assert.equal(sleepTimer(player), null);
  const again = request(client, 'cancel', { roles: ['999'] });
  await execute(again);
  assert.equal(again.replies[0], 'No sleep timer is set.');
});

test('/sleep after-track needs a finite current track', async () => {
  const idle = fakePlayer({ queue: { current: null, tracks: [], previous: [] } });
  const idleRequest = request(fakeClient(idle), 'after-track');
  await execute(idleRequest);
  assert.match(idleRequest.replies[0], /Nothing is playing/);
  const live = fakePlayer();
  live.queue.current.info.isStream = true;
  const liveRequest = request(fakeClient(live), 'after-track');
  await execute(liveRequest);
  assert.match(liveRequest.replies[0], /live stream has no end/);
  assert.equal(sleepTimer(idle), null);
  assert.equal(sleepTimer(live), null);
});

test('a firing sleep timer stops exactly like Stop and posts a silent notice', async () => {
  const player = fakePlayer();
  const client = fakeClient(player);
  assert.equal(await sleepStop(client, player, 'track'), true);
  assert.deepEqual(player.calls, [['stopPlaying', true, false], ['destroy', undefined]]);
  assert.equal(player.getData('vybertron.stopping'), true);
  assert.deepEqual(client.sessions, [null], 'the session checkpoint is discarded');
  assert.deepEqual(client.ended, ['finished']);
  assert.equal(client.notices.length, 1);
  assert.equal(client.notices[0].content, 'Sleep timer stopped playback and disconnected.');
  assert.equal(client.notices[0].flags, MessageFlags.SuppressNotifications);
  assert.deepEqual(client.notices[0].allowedMentions.parse, []);
});

test('a sleep timer for an ended or replaced player does nothing', async () => {
  const player = fakePlayer();
  const client = fakeClient(fakePlayer());
  assert.equal(await sleepStop(client, player, 'time'), false);
  const stopping = fakePlayer();
  stopping.setData('vybertron.stopping', true);
  assert.equal(await sleepStop(fakeClient(stopping), stopping, 'time'), false);
  const destroying = fakePlayer();
  destroying.setData('internal_destroystatus', true);
  const destroyingClient = fakeClient(destroying);
  assert.equal(await sleepStop(destroyingClient, destroying, 'time'), false);
  assert.deepEqual([...player.calls, ...stopping.calls, ...destroying.calls], []);
  assert.deepEqual(destroyingClient.sessions, [], 'a disconnect keeps its checkpoint');
});

test('the player shows an active sleep timer', () => {
  const player = fakePlayer();
  setSleepTimer(player, { afterTrack: true, onFire() {} });
  assert.match(buildPlayerPayload(player).embeds[0].data.description, /Sleep timer: stops after this track/);
  setSleepTimer(player, { minutes: 10, onFire() {}, now: 1_700_000_000_000 });
  assert.match(buildPlayerPayload(player).embeds[0].data.description, /Sleep timer: stops <t:1700000600:R>/);
  assert.doesNotMatch(buildPlayerPayload(player, { state: 'ended' }).embeds[0].data.description, /Sleep timer/);
  cancelSleepTimer(player);
  assert.doesNotMatch(buildPlayerPayload(player).embeds[0].data.description, /Sleep timer/);
});
