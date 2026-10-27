import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRevisions, suggestionProjection, trackProjection } from '../src/portal/projection.js';
import { savedSession } from '../src/utils/sessions.js';
import { getAudioPreset } from '../src/utils/filters.js';
import { autoplayActive, isAutoplayTrack, radioState } from '../src/utils/radio.js';
import { isPlaybackRecovering } from '../src/playback-recovery.js';
import { seekRevision } from '../src/utils/operations.js';
import { sleepTimer } from '../src/utils/sleep-timer.js';
import { trackReference } from '../src/utils/library.js';
import { track } from './fixtures.js';
import { openLibrary, closeLibraries } from './library-fixture.js';

// The revision as it was computed before the scan was made cheap: a full
// library read and full track projections. Kept to prove the cheap revision
// changes exactly when this one does.
function referenceRevision(client) {
  const epochs = new Map(); const objects = new WeakMap(); let next = 0;
  const objectId = value => {
    if (!value || typeof value !== 'object') return null;
    if (!objects.has(value)) objects.set(value, ++next);
    return objects.get(value);
  };
  for (const event of ['trackStart', 'trackEnd', 'queueEnd', 'playerDestroy']) {
    client.lavalink.on(event, player => { if (player?.guildId) epochs.set(player.guildId, (epochs.get(player.guildId) || 0) + 1); });
  }
  return guildId => {
    const player = client.lavalink?.getPlayer(guildId);
    const guild = client.library.readGuild(guildId);
    const checkpoint = savedSession(client.library, guildId);
    const current = player?.queue?.current;
    const signature = [epochs.get(guildId) || 0, objectId(player), objectId(current), current ? trackProjection(current).id : null,
      (player?.queue?.tracks || []).map(item => [objectId(item), trackProjection(item).id]), player?.voiceChannelId, player?.textChannelId,
      Boolean(player?.paused), Boolean(player?.playing), Boolean(isPlaybackRecovering(player)), player?.volume, player?.repeatMode, getAudioPreset(player).label,
      seekRevision(player), Boolean(player?.queue?.previous?.length), sleepTimer(player),
      Boolean(radioState(player).enabled), radioState(player).override, autoplayActive(client, player), suggestionProjection(player).map(item => item.id),
      Boolean(current && isAutoplayTrack(player, current)), guild.settings, guild.mixes, guild.history.map(item => item.id),
      checkpoint ? [checkpoint.voiceChannelId, checkpoint.textChannelId, checkpoint.tracks, checkpoint.paused, checkpoint.volume, checkpoint.repeatMode] : null];
    return createHash('sha256').update(JSON.stringify(signature)).digest('hex').slice(0, 32);
  };
}

const id = n => `v${String(n).padStart(10, '0')}`;
async function setup(t, { queue = 20 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vybertron-revisions-'));
  const library = await openLibrary(path.join(dir, 'library.json'));
  t.after(async () => { await closeLibraries(); await fs.rm(dir, { recursive: true, force: true }); });
  const client = new EventEmitter(); const manager = new EventEmitter();
  client.library = library; client.lavalink = manager;
  const data = new Map();
  const player = { guildId: '100', voiceChannelId: '300', textChannelId: '400', playing: true, paused: false, volume: 100, repeatMode: 'off', position: 0,
    queue: { current: track(id(9999)), tracks: Array.from({ length: queue }, (_, i) => track(id(7000 + i))), previous: [] },
    getData: key => data.get(key), setData: (key, value) => data.set(key, value), filterManager: {} };
  manager.players = new Map([['100', player]]); manager.getPlayer = guildId => manager.players.get(guildId);
  return { client, manager, library, player };
}

test('the cheap revision changes exactly when the full-library revision does', async t => {
  const f = await setup(t);
  let now = Date.UTC(2026, 9, 1);
  t.mock.timers.enable({ apis: ['Date'], now });
  const reference = referenceRevision(f.client); const revisions = createRevisions(f.client);
  t.after(() => revisions.close());
  const steps = [];
  const record = label => steps.push({ label, reference: reference('100'), revision: revisions.revision('100') });
  const session = (overrides = {}) => ({ savedAt: Date.now(), voiceChannelId: '300', textChannelId: '400', position: 0, paused: false, volume: 100, repeatMode: 'off',
    tracks: [f.player.queue.current, ...f.player.queue.tracks].map(trackReference), ...overrides });
  record('initial');
  record('nothing changed');
  await f.library.recordActivity('100', { id: '200', username: 'Listener' }, 'queue'); record('activity only');
  f.player.paused = true; f.player.playing = false; record('paused');
  f.player.paused = false; f.player.playing = true; record('resumed');
  f.player.volume = 50; record('volume');
  f.player.queue.tracks.reverse(); record('queue reordered');
  f.player.queue.tracks.splice(3, 1); record('track removed');
  f.player.queue.tracks[0].info.title = 'Retitled in place'; record('title only'); // A catalog link identifies a song.
  Object.assign(f.player.queue.tracks[0].info, { identifier: id(3), uri: `https://www.youtube.com/watch?v=${id(3)}` }); record('track resolved in place');
  f.player.queue.tracks[1].info = { ...f.player.queue.tracks[1].info, identifier: id(1), uri: `https://www.youtube.com/watch?v=${id(1)}` }; record('track info replaced');
  await f.library.updateGuild('100', guild => { guild.settings.volume = 40; }); record('settings');
  await f.library.updateGuild('100', guild => { guild.settings.volume = 40; }); record('settings rewritten unchanged');
  await f.library.updateGuild('100', guild => { guild.mixes.road = { ownerId: '200', savedAt: 1, tracks: [trackReference(track(id(1)))] }; }); record('mix saved');
  await f.library.updateGuild('100', guild => { delete guild.mixes.road; }); record('mix deleted');
  await f.library.recordHistory(f.player, track(id(2))); record('history');
  await f.library.saveSession('100', session()); record('checkpoint');
  now += 30_000; t.mock.timers.setTime(now);
  await f.library.saveSession('100', session()); record('checkpoint resaved with only a new time');
  await f.library.saveSession('100', session({ paused: true })); record('checkpoint paused');
  f.manager.emit('trackStart', f.player, f.player.queue.current); record('track started');
  now += 73 * 60 * 60_000; t.mock.timers.setTime(now); record('checkpoint expired');
  now += 30 * 24 * 60 * 60_000; t.mock.timers.setTime(now); record('history aged out');
  await f.library.saveSession('100', null); record('checkpoint cleared');
  f.manager.players.delete('100'); record('player gone');

  for (let i = 0; i < steps.length; i++) {
    for (let j = i + 1; j < steps.length; j++) {
      assert.equal(steps[i].revision === steps[j].revision, steps[i].reference === steps[j].reference, `${steps[i].label} vs ${steps[j].label}`);
    }
  }
  const unchanged = steps.slice(1).filter((step, index) => step.revision === steps[index].revision).map(step => step.label);
  assert.deepEqual(unchanged, ['nothing changed', 'activity only', 'title only', 'settings rewritten unchanged', 'checkpoint resaved with only a new time', 'checkpoint cleared']);
});

test('a revision scan no longer clones the library or reprojects the queue', async t => {
  const f = await setup(t, { queue: 500 });
  await f.library.updateGuild('100', guild => {
    for (let m = 0; m < 25; m++) guild.mixes[`mix ${m}`] = { ownerId: '200', savedAt: 1, tracks: Array.from({ length: 100 }, (_, i) => trackReference(track(id(m * 100 + i)))) };
  });
  for (let i = 0; i < 100; i++) await f.library.recordHistory(f.player, track(id(i)));
  await f.library.saveSession('100', { savedAt: Date.now(), voiceChannelId: '300', textChannelId: '400', position: 0, paused: false, volume: 100, repeatMode: 'off',
    tracks: f.player.queue.tracks.map(trackReference) });
  const revisions = createRevisions(f.client); t.after(() => revisions.close());
  const reads = { guild: 0 }; const readGuild = f.library.readGuild.bind(f.library);
  f.library.readGuild = guildId => { reads.guild++; return readGuild(guildId); };
  const first = revisions.revision('100');
  const started = process.cpuUsage();
  for (let i = 0; i < 40; i++) assert.equal(revisions.revision('100'), first);
  const cpu = process.cpuUsage(started); const msPerRevision = (cpu.user + cpu.system) / 1000 / 40;
  assert.equal(reads.guild, 0, 'no full guild read, clone or history parse');
  t.diagnostic(`revision CPU with a 500-track queue and 25 x 100 mixes: ${msPerRevision.toFixed(2)} ms`);
  // The previous scan took about 29 ms of CPU here. Leave room for slow CI hosts.
  assert.ok(msPerRevision < 10, `${msPerRevision.toFixed(2)} ms per revision`);
});
