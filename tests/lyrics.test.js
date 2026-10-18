import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { buildLyricsPayload, clearLyricsCache, LYRICS_LIMITS, lyricsPages, normalizeLyrics, trackLyrics } from '../src/utils/lyrics.js';
import { execute } from '../src/commands/lyrics.js';
import { handleMessageComponent } from '../src/utils/components.js';
import { commandMutationPolicy } from '../src/utils/requests.js';
import { portalFixture } from './portal-fixtures.js';
import { track } from './fixtures.js';

const synced = { sourceName: 'lrclib', provider: 'LRCLIB', text: null, lines: [
  { timestamp: 12_000, duration: 3000, line: 'Second line' }, { timestamp: 9000, duration: 3000, line: 'First line' }, { timestamp: 15_000, duration: 0, line: '' },
] };

function lyricsNode(responses) {
  const node = { connected: true, paths: [], async request(path) {
    node.paths.push(path);
    const next = typeof responses === 'function' ? responses(path) : responses.shift();
    if (next instanceof Error) throw next;
    return next;
  } };
  return node;
}

test('synced lyrics keep their timing in order; plain text becomes untimed lines', () => {
  const lyrics = normalizeLyrics(synced);
  assert.deepEqual(lyrics, { source: 'lrclib', provider: 'LRCLIB', synced: true, lines: [{ startMs: 9000, text: 'First line' }, { startMs: 12_000, text: 'Second line' }] });
  const plain = normalizeLyrics({ sourceName: 'youtube', provider: null, text: '\nVerse one\n\n\n\nVerse two\u0000\n', lines: [] });
  assert.equal(plain.synced, false);
  assert.deepEqual(plain.lines.map(line => line.text), ['Verse one', '', 'Verse two']);
  assert.ok(plain.lines.every(line => line.startMs === null));
  assert.equal(normalizeLyrics({ sourceName: 'x', text: '  \n ', lines: [] }), null);
  assert.equal(normalizeLyrics({ timestamp: 1, status: 500, error: 'Internal Server Error' }), null);
});

test('lyrics requests escape the encoded track, cache answers and never cache failures', async () => {
  clearLyricsCache();
  const song = { ...track('cache000001'), encoded: 'QAAA+/b=' };
  const node = lyricsNode([synced]);
  const found = await trackLyrics(node, song);
  assert.equal(found.status, 'found');
  assert.equal(node.paths[0], '/lyrics?track=QAAA%2B%2Fb%3D&skipTrackSource=false');
  assert.equal(await trackLyrics(node, song), found, 'a second read is served from the cache');
  assert.equal(node.paths.length, 1);

  const missing = lyricsNode([undefined]);
  assert.deepEqual(await trackLyrics(missing, track('missing0001')), { status: 'not_found' });
  const broken = lyricsNode([new Error('Node Request resulted into an error'), { timestamp: 1, status: 500, error: 'Internal Server Error', path: '/v4/lyrics' }, synced]);
  const song2 = track('broken00001');
  assert.deepEqual(await trackLyrics(broken, song2), { status: 'unavailable' }, 'a missing plugin is unavailable, not "no lyrics"');
  assert.deepEqual(await trackLyrics(broken, song2), { status: 'unavailable' }, 'an error body is unavailable');
  assert.equal((await trackLyrics(broken, song2)).status, 'found', 'failures are retried');
  assert.deepEqual(await trackLyrics({ connected: false }, track('offline0001')), { status: 'unavailable' });
  assert.deepEqual(await trackLyrics(node, { info: { title: 'Unresolved' } }), { status: 'not_found' });
});

test('long lyrics paginate within Discord embed limits and neutralize mentions and markdown', () => {
  const lines = Array.from({ length: 400 }, (_, index) => ({ startMs: null, text: `${index % 9 ? '' : '@everyone '}**line** ${index} ${'x'.repeat(index % 50)}` }));
  const lyrics = { source: 'lrclib', provider: 'LRCLIB', synced: false, lines };
  const pages = lyricsPages(lyrics);
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.length <= LYRICS_LIMITS.pageCharacters && page.split('\n').length <= LYRICS_LIMITS.pageLines));
  assert.ok(pages.every(page => !page.includes('@everyone') && !page.includes('**line**')));
  const song = track('longsong001');
  for (const page of [0, pages.length - 1, 999]) {
    const payload = buildLyricsPayload(song, { status: 'found', lyrics }, page, 'listener');
    const json = payload.embeds[0].toJSON();
    assert.ok(json.title.length <= 256 && json.description.length <= 4096 && json.footer.text.length <= 2048);
    assert.match(json.footer.text, /Page \d+ of \d+ • Lyrics from LRCLIB • Only you can see this/);
    const [previous, next] = payload.components[0].components.map(button => button.toJSON());
    assert.ok(previous.custom_id.length <= 100 && next.custom_id.length <= 100);
    assert.equal(previous.disabled, page === 0);
    assert.equal(next.disabled, page !== 0);
    assert.deepEqual(payload.allowedMentions.parse, []);
  }
  assert.equal(buildLyricsPayload(song, { status: 'found', lyrics: { ...lyrics, lines: lines.slice(0, 3) } }).components.length, 0, 'one page needs no buttons');
  assert.match(buildLyricsPayload(song, { status: 'not_found' }).embeds[0].data.description, /^No lyrics found for Song longsong001 — Artist\.$/);
  assert.match(buildLyricsPayload(song, { status: 'unavailable' }).embeds[0].data.description, /unavailable right now/);
});

function interaction(player, { position = null, customId, user = 'listener' } = {}) {
  const calls = [];
  const channels = new Map(['voice', 'text'].map(id => [id, { guildId: 'guild', permissionsFor: () => ({ has: () => true }) }]));
  return {
    calls, guildId: 'guild', user: { id: user }, member: { id: user }, customId, guild: { channels: { cache: channels } },
    client: { lavalink: { getPlayer: () => player } },
    options: { getInteger: () => position },
    isButton: () => true,
    async reply(payload) { calls.push(['reply', payload]); }, async deferReply(payload) { calls.push(['deferReply', payload]); },
    async editReply(payload) { calls.push(['editReply', payload]); }, async deferUpdate() { calls.push(['deferUpdate']); },
    async update(payload) { calls.push(['update', payload]); }, async followUp(payload) { calls.push(['followUp', payload]); },
  };
}

test('/lyrics is a private read-only reply for the current song or a queued song', async () => {
  clearLyricsCache();
  assert.equal(commandMutationPolicy('lyrics').readOnly, true);
  const node = lyricsNode(path => path.includes('encoded-current0001') ? synced : undefined);
  const player = { voiceChannelId: 'voice', textChannelId: 'text', node, queue: { current: track('current0001'), tracks: [track('upcoming001'), { info: { title: 'Loading' } }] } };

  const current = interaction(player);
  await execute(current);
  assert.deepEqual(current.calls[0], ['deferReply', { flags: MessageFlags.Ephemeral }]);
  assert.equal(current.calls[1][1].embeds[0].data.description, 'First line\nSecond line');

  const queued = interaction(player, { position: 1 });
  await execute(queued);
  assert.match(queued.calls[1][1].embeds[0].data.description, /No lyrics found for Song upcoming001/);

  const unresolved = interaction(player, { position: 2 });
  await execute(unresolved);
  assert.equal(unresolved.calls[0][0], 'reply');
  assert.equal(unresolved.calls[0][1].flags, MessageFlags.Ephemeral);
  assert.match(unresolved.calls[0][1].content ?? unresolved.calls[0][1].embeds[0].data.description, /hasn’t loaded yet/);

  const outOfRange = interaction(player, { position: 9 });
  await execute(outOfRange);
  assert.match(JSON.stringify(outOfRange.calls[0][1]), /no song at position 9/);

  const idle = interaction(undefined);
  await execute(idle);
  assert.match(JSON.stringify(idle.calls[0][1]), /Nothing is playing/);
  assert.equal(node.paths.length, 2, 'unloaded and missing songs never reach the audio server');
});

test('lyrics pages turn for their owner while the song is still in the session', async () => {
  clearLyricsCache();
  const long = { sourceName: 'lrclib', provider: 'LRCLIB', text: Array.from({ length: 130 }, (_, index) => `Line ${index}`).join('\n'), lines: [] };
  const node = lyricsNode(() => long);
  const song = track('pagedsong01');
  const player = { voiceChannelId: 'voice', textChannelId: 'text', node, queue: { current: song, tracks: [] } };
  const opened = interaction(player);
  await execute(opened);
  const next = opened.calls[1][1].components[0].components[1].toJSON().custom_id;

  const turned = interaction(player, { customId: next });
  await handleMessageComponent(turned);
  assert.equal(turned.calls[0][0], 'deferUpdate');
  assert.match(turned.calls[1][1].embeds[0].data.footer.text, /^Page 2 of 3/);

  const stranger = interaction(player, { customId: next, user: 'someone-else' });
  await handleMessageComponent(stranger);
  assert.match(JSON.stringify(stranger.calls[0][1]), /Only the person who opened these lyrics/);

  player.queue.current = track('another0001');
  const gone = interaction(player, { customId: next });
  await handleMessageComponent(gone);
  assert.deepEqual(gone.calls[0], ['update', { components: [] }]);
  assert.match(JSON.stringify(gone.calls[1][1]), /left the session/);
});

test('the portal bridge serves lyrics for the visible current song only', async t => {
  clearLyricsCache();
  const f = await portalFixture(t);
  const withLyrics = encodeURIComponent(f.player.queue.current.encoded);
  f.node.request = async path => path.includes(withLyrics) ? synced : undefined;
  const found = await f.request('/lyrics');
  assert.equal(found.status, 200);
  assert.equal(found.body.status, 'found');
  assert.match(found.body.trackId, /^[a-f0-9]{24}$/);
  assert.deepEqual(found.body.lyrics.lines[0], { startMs: 9000, text: 'First line' });
  assert.doesNotMatch(JSON.stringify(found.body), /encoded|never-save/);

  f.channels.get('300').hidden.add('200');
  const hidden = await f.request('/lyrics');
  assert.equal(hidden.status, 200);
  assert.deepEqual(hidden.body, { trackId: null, status: 'idle', lyrics: null });

  f.channels.get('300').hidden.delete('200');
  f.player.queue.current = track('nolyrics001');
  const missing = await f.request('/lyrics');
  assert.equal(missing.body.status, 'not_found');
  assert.equal(missing.body.lyrics, null);
});
