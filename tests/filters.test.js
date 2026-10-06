import test from 'node:test';
import assert from 'node:assert/strict';
import { FilterManager } from 'lavalink-client';
import { applyAudioPreset, AUDIO_PRESETS, getAudioPreset } from '../src/utils/filters.js';
import { execute as filterCommand } from '../src/commands/filter.js';

function fixture({ supported = ['volume', 'equalizer', 'timescale', 'channelMix'] } = {}) {
  const requests = [];
  const player = {
    guildId: 'guild', voiceChannelId: 'voice', volume: 80, options: {}, ping: {},
    queue: { current: { info: { title: 'Track', duration: 60_000 } }, tracks: [] },
    triggerPlayerClientUpdate() {},
    node: {
      sessionId: 'session', _checkForSources: true, info: { filters: supported },
      async updatePlayer(request) { requests.push(structuredClone(request)); },
    },
  };
  player.filterManager = new FilterManager(player);
  return { player, requests };
}

test('audio presets use the installed FilterManager and replace effects in one request', async () => {
  const { player, requests } = fixture();
  await applyAudioPreset(player, 'bass');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].playerOptions.filters.volume, 0.84);
  assert.equal(requests[0].playerOptions.filters.equalizer.length, 15);
  assert.ok(requests[0].playerOptions.filters.equalizer.every(({ band, gain }) => band >= 0 && band <= 14 && gain >= -0.25 && gain <= 1));
  assert.equal(player.volume, 80);
  assert.equal(getAudioPreset(player).label, 'Bass');

  await applyAudioPreset(player, 'nightcore');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].playerOptions.filters, { timescale: { speed: 1.12, pitch: 1.08, rate: 1 } });
  assert.equal(getAudioPreset(player).label, 'Nightcore');
});

test('Original resets every effect including EQ without changing playback volume', async () => {
  const { player, requests } = fixture();
  await applyAudioPreset(player, 'clarity');
  player.filterManager.data.karaoke = { level: 1, monoLevel: 1, filterBand: 220, filterWidth: 100 };
  player.filterManager.data.pluginFilters = { echo: { echoLength: 0.5, decay: 0.5 } };
  await applyAudioPreset(player, 'off');
  assert.deepEqual(requests.at(-1).playerOptions.filters, {});
  assert.deepEqual(player.filterManager.equalizerBands, []);
  assert.equal(player.volume, 80);
  assert.equal(getAudioPreset(player).label, 'Original');
});

test('every preset produces only standard advertised filters and valid timescales', async () => {
  for (const key of Object.keys(AUDIO_PRESETS)) {
    const { player, requests } = fixture();
    await applyAudioPreset(player, key);
    const filters = requests[0].playerOptions.filters;
    assert.ok(Object.keys(filters).every((filter) => player.node.info.filters.includes(filter)), key);
    if (filters.timescale) assert.ok(Object.values(filters.timescale).every((value) => Number.isFinite(value) && value > 0), key);
    if (filters.volume) assert.ok(filters.volume > 0 && filters.volume <= 1, key);
  }
});

test('unsupported filters do not mutate sound or send requests', async () => {
  const { player, requests } = fixture({ supported: ['volume', 'equalizer'] });
  const managerData = player.filterManager.data;
  assert.match((await applyAudioPreset(player, 'nightcore')).error, /unavailable/);
  assert.equal(requests.length, 0);
  assert.equal(player.filterManager.data, managerData);
  assert.match((await applyAudioPreset(player, 'unknown')).error, /available audio presets/);
});

test('a failed apply restores local state; concurrent preset changes stay ordered', async () => {
  const { player, requests } = fixture();
  await applyAudioPreset(player, 'warm');
  const snapshot = player.filterManager.data;
  const bands = player.filterManager.equalizerBands;
  player.node.updatePlayer = async () => { throw new Error('audio server unavailable'); };
  await assert.rejects(applyAudioPreset(player, 'bass'), /unavailable/);
  assert.equal(player.filterManager.data, snapshot);
  assert.equal(player.filterManager.equalizerBands, bands);
  assert.equal(getAudioPreset(player).label, 'Warm');

  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  player.node.updatePlayer = async (request) => { requests.push(structuredClone(request)); if (requests.length === 2) await waiting; };
  const first = applyAudioPreset(player, 'nightcore');
  const second = applyAudioPreset(player, 'mono');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  release();
  await Promise.all([first, second]);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.at(-1).playerOptions.filters.channelMix, { leftToLeft: 0.5, leftToRight: 0.5, rightToLeft: 0.5, rightToRight: 0.5 });
  assert.equal(getAudioPreset(player).label, 'Mono');
});

test('/filter defers before network changes and checks same voice; viewing does not require voice', async () => {
  const { player, requests } = fixture();
  const calls = [];
  const interaction = {
    guildId: 'guild', user: { id: 'listener' }, options: { getString: () => 'warm' },
    member: { voice: { channel: { id: 'other' } } },
    client: { lavalink: { getPlayer: () => player } },
    async reply(payload) { calls.push(['reply', payload]); },
    async deferReply() { calls.push(['deferReply']); },
    async editReply(payload) { calls.push(['editReply', payload]); },
  };
  await filterCommand(interaction);
  assert.equal(requests.length, 0);
  assert.match(calls[0][1].content, /voice channel/);
  calls.length = 0;
  interaction.member.voice.channel.id = 'voice';
  await filterCommand(interaction);
  assert.deepEqual(calls.map(([name]) => name), ['deferReply', 'editReply']);
  assert.equal(requests.length, 1);
  interaction.options.getString = () => null;
  interaction.member.voice.channel = null;
  calls.length = 0;
  await filterCommand(interaction);
  assert.match(calls[0][1].content, /Current audio: Warm/);
});
