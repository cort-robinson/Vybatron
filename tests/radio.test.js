import test from 'node:test';
import assert from 'node:assert/strict';
import { fillRadioQueue, setRadio, radioState } from '../src/utils/radio.js';
import { maintenanceStatus, setMaintenance } from '../src/utils/maintenance.js';
import { track } from './fixtures.js';

function fixture(search) {
  const current = track();
  const player = { guildId: '100', voiceChannelId: '300', queue: { current: null, previous: [current], tracks: [], async add(tracks) { this.tracks.push(...tracks); } }, search };
  const channel = { members: new Map([['200', { user: { bot: false } }]]) };
  const client = { user: { id: '999', username: 'Vybertron' }, lavalink: { getPlayer: () => player }, guilds: { cache: new Map([['100', { channels: { cache: new Map([['300', channel]]) } }]]) } };
  return { player, client, current, channel };
}

test('radio is opt-in, excludes recent recordings/live compilations and keeps human requests ahead', async () => {
  const f = fixture(async () => ({ tracks: [track(), { ...track('live0000000'), info: { ...track().info, isStream: true } }, track('lmnopqrstuv')] }));
  assert.equal(await fillRadioQueue(f.player, f.current, f.client), false);
  setRadio(f.player, true, f.current);
  assert.equal(await fillRadioQueue(f.player, f.current, f.client, { random: () => 0 }), true);
  assert.equal(f.player.queue.tracks[0].info.identifier, 'lmnopqrstuv');
  assert.equal(f.player.queue.tracks[0].requester.id, '999');
  assert.equal(await fillRadioQueue(f.player, f.current, f.client), false);
  assert.equal(maintenanceStatus(f.client).inFlight, 0);
});

test('turning radio off, destroying a session, or queuing a song during discovery prevents late insertion', async () => {
  for (const change of ['off', 'destroy', 'enqueue']) {
    let complete; const f = fixture(() => new Promise(resolve => { complete = resolve; }));
    setRadio(f.player, true, f.current);
    const pending = fillRadioQueue(f.player, f.current, f.client);
    await new Promise(resolve => setImmediate(resolve));
    if (change === 'off') setRadio(f.player, false);
    if (change === 'destroy') f.client.lavalink.getPlayer = () => null;
    if (change === 'enqueue') f.player.queue.tracks.push(track('user0000000'));
    complete({ tracks: [track('lmnopqrstuv')] });
    assert.equal(await pending, false);
    assert.equal(f.player.queue.tracks.length, change === 'enqueue' ? 1 : 0);
  }
});

test('empty voice channels, maintenance, and source outages cannot create radio retry storms', async () => {
  let searches = 0;
  const f = fixture(async () => { searches++; throw new Error('source failed'); });
  setRadio(f.player, true, f.current);
  f.channel.members.clear(); assert.equal(await fillRadioQueue(f.player, f.current, f.client), false);
  assert.equal(searches, 0);
  f.channel.members.set('200', { user: { bot: false } });
  setMaintenance(f.client, true); await fillRadioQueue(f.player, f.current, f.client); assert.equal(searches, 0);
  setMaintenance(f.client, false);
  await Promise.all([fillRadioQueue(f.player, f.current, f.client), fillRadioQueue(f.player, f.current, f.client)]);
  assert.equal(searches, 1);
  await fillRadioQueue(f.player, f.current, f.client); await fillRadioQueue(f.player, f.current, f.client);
  assert.equal(radioState(f.player).enabled, false);
  assert.equal(maintenanceStatus(f.client).inFlight, 0);
});
