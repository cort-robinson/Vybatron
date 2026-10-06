import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execute as play, autocomplete } from '../src/commands/play.js';
import { execute as playnext } from '../src/commands/playnext.js';
import { execute as stop } from '../src/commands/stop.js';
import { execute as skip } from '../src/commands/skip.js';
import { execute as session } from '../src/commands/session.js';
import { execute as mix } from '../src/commands/mix.js';
import { MusicLibrary, trackReference } from '../src/utils/library.js';
import { attachSessionSnapshots, savedSession } from '../src/utils/sessions.js';
import { guardedMutation } from '../src/utils/requests.js';
import { maintenanceStatus } from '../src/utils/maintenance.js';
import { track } from './fixtures.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function savedCheckpoint(overrides = {}) {
  return {
    voiceChannelId: '300', textChannelId: '400', savedAt: Date.now(),
    tracks: [trackReference(track()), trackReference(track('lmnopqrstuv'))],
    position: 8000, volume: 75, paused: true, repeatMode: 'queue',
    ...overrides,
  };
}

async function libraryFixture(t) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'vybertron-v2-integration-'));
  const filePath = path.join(directory, 'library.json');
  const library = await new MusicLibrary(filePath).open();
  t.after(async () => {
    await library.close();
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    assert.ok(path.basename(directory).startsWith('vybertron-v2-integration-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { library, filePath };
}

// The manager uses real event ordering. Like Lavalink's native destroy(), the
// fake player leaves queue.current in memory after disconnecting and deletion.
function environment(library, { existing = true, current = null, search } = {}) {
  const manager = new EventEmitter();
  manager.players = new Map();
  manager.getPlayer = guildId => manager.players.get(guildId);
  const client = { library, lavalink: manager, channels: { cache: new Map() } };
  for (const id of ['300', '400']) client.channels.cache.set(id, { id, guildId: '100', permissionsFor: () => new PermissionsBitField([P.ViewChannel]) });
  const calls = [];
  function createPlayer(options = {}) {
    const data = new Map();
    const player = {
      guildId: '100', voiceChannelId: '300', textChannelId: '400',
      connected: Boolean(current), playing: Boolean(current), paused: false,
      position: 8000, lastPosition: 8000, volume: 100, repeatMode: 'off',
      node: { connected: true },
      queue: {
        current, tracks: [], previous: [],
        async add(incoming) { calls.push(['add', incoming]); this.tracks.push(...incoming); },
        async splice(start, count, incoming = []) {
          calls.push(['splice', start, count, incoming]);
          return this.tracks.splice(start, count, ...incoming);
        },
        utils: { async save() {} },
      },
      getData: key => data.get(key),
      setData: (key, value) => data.set(key, value),
      async search(...args) {
        calls.push(['search', ...args]);
        return search ? search(...args) : { loadType: 'track', tracks: [track()] };
      },
      async connect() { calls.push(['connect']); this.connected = true; this.voiceChannelId = '300'; },
      async play(options = {}) {
        calls.push(['play', options]);
        this.queue.current = options.clientTrack || this.queue.current || this.queue.tracks.shift();
        this.paused = Boolean(options.paused); this.playing = !this.paused;
      },
      async setVolume(volume) { calls.push(['setVolume', volume]); this.volume = volume; },
      async setRepeatMode(mode) { calls.push(['setRepeatMode', mode]); this.repeatMode = mode; },
      async seek(position) { calls.push(['seek', position]); },
      async pause(paused) { calls.push(['pause', paused]); this.paused = paused; },
      async stopPlaying(clearQueue, autoplay) {
        calls.push(['stopPlaying', clearQueue, autoplay]);
        if (clearQueue) this.queue.tracks.length = 0;
        this.playing = false;
      },
      async destroy(reason) {
        calls.push(['destroy', reason]);
        this.voiceChannelId = null; this.connected = false; this.playing = false;
        if (manager.getPlayer(this.guildId) === this) manager.players.delete(this.guildId);
        manager.emit('playerDestroy', this, reason);
      },
      ...options,
    };
    manager.players.set(player.guildId, player);
    return player;
  }
  manager.createPlayer = options => createPlayer(options);
  const player = existing ? createPlayer() : null;
  return { client, manager, player, calls, createPlayer };
}

function interaction(client, commandName, { action, query = 'song and artist', name = 'late night' } = {}) {
  const responses = [];
  return {
    client, commandName, guildId: '100', guild: { id: '100', channels: client.channels }, channelId: '400', deferred: false, replied: false,
    user: { id: '200', username: 'Listener' },
    member: { voice: { channel: { id: '300', joinable: true, speakable: true } }, roles: { cache: new Map([['500', {}]]) } },
    memberPermissions: { has: () => false }, responses,
    options: {
      getSubcommand: () => action,
      getString: key => key === 'query' ? query : name,
      getFocused: () => query,
      getBoolean: () => false,
    },
    isMessageComponent: () => false, isModalSubmit: () => false,
    async deferReply(payload) { this.deferred = true; responses.push(['deferReply', payload]); },
    async reply(payload) { this.replied = true; responses.push(['reply', payload]); },
    async editReply(payload) { this.replied = true; responses.push(['editReply', payload]); },
    async followUp(payload) { responses.push(['followUp', payload]); },
    async respond(payload) { responses.push(['respond', payload]); },
  };
}

function dispatch(request, execute, options = {}) {
  return guardedMutation(request, execute, { playback: true, ...options });
}

test('intentional stop and destroy clear a durable checkpoint even with a retained native current track', async t => {
  for (const command of ['stop', 'destroy']) await t.test(command, async t => {
    const { library, filePath } = await libraryFixture(t);
    await library.updateGuild('100', guild => { guild.session = savedCheckpoint(); });
    const { client, manager, player, calls } = environment(library, { current: track() });
    library.stopSnapshots = attachSessionSnapshots(client, { intervalMs: 60_000 });
    // A scheduled checkpoint must also be cancelled rather than resurrecting it.
    manager.emit('trackStart', player);
    if (command === 'stop') await dispatch(interaction(client, 'stop'), stop, { urgent: true });
    else await player.destroy();
    await library.pending;
    await delay(550);
    await library.pending;
    assert.ok(player.queue.current, 'native destroy does not clear the current track object');
    assert.equal(manager.getPlayer('100'), undefined);
    assert.equal((await new MusicLibrary(filePath).open()).readGuild('100').session, null);
    if (command === 'stop') assert.deepEqual(calls.find(call => call[0] === 'stopPlaying'), ['stopPlaying', true, false]);
  });
});

test('an unused player from an empty or failed lookup preserves the prior eligible checkpoint', async t => {
  for (const failure of ['empty', 'rejected']) await t.test(failure, async t => {
    const { library, filePath } = await libraryFixture(t);
    const checkpoint = savedCheckpoint();
    await library.updateGuild('100', guild => { guild.session = checkpoint; });
    const { client, manager, calls } = environment(library, {
      existing: false,
      search: () => failure === 'empty' ? { loadType: 'empty', tracks: [] } : Promise.reject(new Error('source unavailable')),
    });
    library.stopSnapshots = attachSessionSnapshots(client, { intervalMs: 60_000 });
    const request = dispatch(interaction(client, 'play'), play);
    if (failure === 'rejected') await assert.rejects(request, /source unavailable/);
    else await request;
    await library.pending;
    const reopened = await new MusicLibrary(filePath).open();
    assert.deepEqual(savedSession(reopened, '100'), checkpoint);
    assert.equal(manager.getPlayer('100'), undefined);
    assert.deepEqual(calls.find(call => call[0] === 'destroy'), ['destroy', 'unused-request-disconnect']);
  });
});

test('lookup completion rechecks voice membership, player identity and DJ authorization before any enqueue', async t => {
  const cases = [
    { command: 'play', change: 'left', execute: play },
    { command: 'play', change: 'moved', execute: play },
    { command: 'play', change: 'replaced', execute: play },
    { command: 'playnext', change: 'left', execute: playnext },
    { command: 'playnext', change: 'revoked', execute: playnext },
    { command: 'mix', action: 'load', change: 'moved', execute: mix },
    { command: 'session', action: 'resume', change: 'left', execute: session },
    { command: 'session', action: 'resume', change: 'revoked', execute: session },
  ];
  for (const item of cases) await t.test(`${item.command}: ${item.change}`, async t => {
    const { library } = await libraryFixture(t);
    await library.updateGuild('100', guild => {
      guild.settings.djRoleId = '500';
      guild.session = savedCheckpoint();
      guild.mixes['late night'] = { ownerId: '200', tracks: [trackReference(track())], savedAt: Date.now() };
    });
    const lookup = deferred(); const started = deferred();
    const { client, manager, player, calls, createPlayer } = environment(library, {
      search: () => { started.resolve(); return lookup.promise; },
    });
    const request = interaction(client, item.command, { action: item.action });
    const running = dispatch(request, item.execute);
    await started.promise;
    if (item.change === 'left') request.member.voice.channel = null;
    if (item.change === 'moved') request.member.voice.channel = { id: '301', joinable: true, speakable: true };
    if (item.change === 'revoked') request.member.roles.cache.delete('500');
    if (item.change === 'replaced') createPlayer();
    lookup.resolve({ loadType: 'track', tracks: [track()] });
    await running;
    assert.equal(player.queue.tracks.length, 0);
    assert.equal(player.queue.current, null);
    assert.equal(calls.some(call => ['add', 'splice', 'connect', 'play', 'setVolume', 'setRepeatMode'].includes(call[0])), false);
    assert.equal(request.responses.at(-1)[0], 'editReply');
    assert.equal(request.responses.some(response => response[0] === 'followUp'), false);
    assert.equal(maintenanceStatus(client).inFlight, 0);
    if (item.change !== 'replaced') assert.equal(manager.getPlayer('100'), player);
  });
});

test('a pre-deferred slash voice rejection completes its original reply without invoking the control', async t => {
  const { library } = await libraryFixture(t);
  const { client, player, calls } = environment(library, { current: track() });
  const request = interaction(client, 'skip');
  request.member.voice.channel = { id: '301' };
  await dispatch(request, skip);
  assert.deepEqual(request.responses.map(response => response[0]), ['deferReply', 'editReply']);
  assert.match(request.responses[1][1].content, /voice channel/i);
  assert.equal(request.responses[1][1].flags, undefined);
  assert.equal(player.queue.current.info.identifier, 'abcdefghijk');
  assert.equal(calls.length, 0);
});

test('a paused session resumes with position and pause in its first playback request', async t => {
  const { library } = await libraryFixture(t);
  const checkpoint = savedCheckpoint();
  await library.updateGuild('100', guild => { guild.session = checkpoint; });
  const { client, player, calls } = environment(library, {
    search: ({ query }) => ({ loadType: 'track', tracks: [track(new URL(query).searchParams.get('v'))] }),
  });
  const request = interaction(client, 'session', { action: 'resume' });
  await dispatch(request, session);
  const starts = calls.filter(call => call[0] === 'play');
  assert.equal(starts.length, 1);
  assert.equal(starts[0][1].clientTrack.info.identifier, 'abcdefghijk');
  assert.equal(starts[0][1].position, 8000);
  assert.equal(starts[0][1].paused, true);
  assert.equal(calls.some(call => ['seek', 'pause'].includes(call[0])), false);
  assert.equal(player.paused, true);
  assert.equal(player.queue.tracks.length, 1);
  assert.equal(player.queue.tracks[0].info.identifier, 'lmnopqrstuv');
  assert.match(request.responses.at(-1)[1].content, /kept playback paused/);
});

test('SDK loader prefixes never reach search through slash commands or autocomplete', async t => {
  const { library } = await libraryFixture(t);
  for (const query of ['link:https://127.0.0.1/admin', 'ytsearch:https://127.0.0.1/admin', 'uri:file:///private.mp3']) {
    const { client, calls } = environment(library);
    let nodeSearches = 0;
    client.lavalink.nodeManager = { leastUsedNodes: () => [{ search: () => { nodeSearches++; return { tracks: [track()] }; } }] };
    for (const [command, execute] of [['play', play], ['playnext', playnext]]) {
      const request = interaction(client, command, { query });
      await dispatch(request, execute);
      assert.match(request.responses.at(-1)[1].content, /public HTTPS catalog link/);
    }
    const suggestion = interaction(client, 'play', { query });
    await autocomplete(suggestion);
    assert.deepEqual(suggestion.responses.at(-1), ['respond', []]);
    assert.equal(nodeSearches, 0);
    assert.equal(calls.length, 0);
  }
});

test('invalid durable reference and session fields fail startup without overwriting the persisted file', async t => {
  const { library, filePath } = await libraryFixture(t);
  await library.updateFavorites('200', list => { list.push(trackReference(track())); });
  await library.updateGuild('100', guild => {
    guild.mixes['late night'] = { ownerId: '200', tracks: [trackReference(track())], savedAt: Date.now() };
    guild.session = savedCheckpoint();
  });
  const clean = library.document;
  const referenceChanges = [
    ['credential-bearing URL', ref => { ref.uri += '&token=private'; }],
    ['unsafe loader URL', ref => { ref.uri = 'file:///private.mp3'; }],
    ['extra encoded audio', ref => { ref.encoded = 'expired-secret'; }],
    ['extra requester metadata', ref => { ref.requester = { id: '200', token: 'private' }; }],
    ['invalid duration type', ref => { ref.duration = '180000'; }],
    ['invalid stream type', ref => { ref.isStream = 'false'; }],
    ['unrecognized source', ref => { ref.sourceName = 'http'; }],
  ];
  for (const collection of ['favorites', 'mixes', 'session']) {
    for (const [label, mutate] of referenceChanges) await t.test(`${collection}: ${label}`, async () => {
      const invalid = structuredClone(clean);
      const guild = invalid.guilds['100'];
      const ref = collection === 'favorites' ? invalid.favorites['200'][0]
        : collection === 'mixes' ? guild.mixes['late night'].tracks[0] : guild.session.tracks[0];
      mutate(ref);
      const serialized = JSON.stringify(invalid);
      await fs.writeFile(filePath, serialized);
      await assert.rejects(new MusicLibrary(filePath).open(), /Invalid/);
      assert.equal(await fs.readFile(filePath, 'utf8'), serialized);
    });
  }
  const sessionChanges = [
    ['out-of-range volume', saved => { saved.volume = 999; }],
    ['fractional volume', saved => { saved.volume = 0.5; }],
    ['invalid pause type', saved => { saved.paused = 'false'; }],
    ['invalid repeat mode', saved => { saved.repeatMode = 'forever'; }],
    ['invalid position type', saved => { saved.position = '8000'; }],
    ['negative position', saved => { saved.position = -1; }],
    ['unsafe integer position', saved => { saved.position = Number.MAX_SAFE_INTEGER + 1; }],
    ['empty tracks', saved => { saved.tracks = []; }],
    ['invalid voice ID', saved => { saved.voiceChannelId = 'private'; }],
    ['invalid saved time', saved => { saved.savedAt = null; }],
  ];
  for (const [label, mutate] of sessionChanges) await t.test(`session: ${label}`, async () => {
    const invalid = structuredClone(clean);
    mutate(invalid.guilds['100'].session);
    const serialized = JSON.stringify(invalid);
    await fs.writeFile(filePath, serialized);
    await assert.rejects(new MusicLibrary(filePath).open(), /Invalid saved listening session/);
    assert.equal(await fs.readFile(filePath, 'utf8'), serialized);
  });
});

test('urgent Stop completes during a pending lookup and that lookup cannot revive the destroyed session', async t => {
  const { library, filePath } = await libraryFixture(t);
  await library.updateGuild('100', guild => { guild.session = savedCheckpoint(); });
  const lookup = deferred(); const started = deferred();
  const { client, manager, player, calls } = environment(library, {
    current: track('lmnopqrstuv'),
    search: () => { started.resolve(); return lookup.promise; },
  });
  library.stopSnapshots = attachSessionSnapshots(client, { intervalMs: 60_000 });
  const loading = dispatch(interaction(client, 'play'), play);
  await started.promise;
  const stopping = dispatch(interaction(client, 'stop'), stop, { urgent: true });
  // This checks the independent control path without a real provider or timeout.
  await Promise.race([stopping, delay(500).then(() => assert.fail('Stop waited behind source lookup'))]);
  assert.equal(player.getData('vybertron.stopping'), true);
  assert.equal(manager.getPlayer('100'), undefined);
  const afterStop = calls.length;
  lookup.resolve({ loadType: 'track', tracks: [track()] });
  await loading;
  await library.pending;
  assert.equal(calls.slice(afterStop).some(call => ['add', 'splice', 'connect', 'play'].includes(call[0])), false);
  assert.equal(player.queue.tracks.length, 0);
  assert.equal((await new MusicLibrary(filePath).open()).readGuild('100').session, null);
  assert.equal(maintenanceStatus(client).inFlight, 0);
});

test('urgent Stop fences further playback writes after an asynchronous enqueue or restoration write', async t => {
  for (const stage of ['queue-save', 'session-volume']) await t.test(stage, async t => {
    const { library } = await libraryFixture(t);
    await library.updateGuild('100', guild => { guild.session = savedCheckpoint(); });
    const { client, manager, player, calls } = environment(library, {
      search: ({ query }) => ({ loadType: 'track', tracks: [track(query.startsWith('https:') ? new URL(query).searchParams.get('v') : undefined)] }),
    });
    const pendingWrite = deferred(); const started = deferred();
    if (stage === 'queue-save') {
      const add = player.queue.add;
      player.queue.add = async function (incoming) {
        await add.call(this, incoming);
        started.resolve(); await pendingWrite.promise;
      };
    } else {
      const setVolume = player.setVolume;
      player.setVolume = async function (volume) {
        await setVolume.call(this, volume);
        started.resolve(); await pendingWrite.promise;
      };
    }
    const command = stage === 'queue-save' ? play : session;
    const name = stage === 'queue-save' ? 'play' : 'session';
    const loading = dispatch(interaction(client, name, { action: 'resume' }), command);
    await started.promise;
    await dispatch(interaction(client, 'stop'), stop, { urgent: true });
    const afterStop = calls.length;
    pendingWrite.resolve();
    await loading;
    assert.equal(manager.getPlayer('100'), undefined);
    assert.equal(calls.slice(afterStop).some(call => ['connect', 'setRepeatMode', 'play'].includes(call[0])), false,
      'a completed Stop must prevent new playback writes from the older operation');
    assert.equal(player.voiceChannelId, null);
    assert.equal(maintenanceStatus(client).inFlight, 0);
  });
});
