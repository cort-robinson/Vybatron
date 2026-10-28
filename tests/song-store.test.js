import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { catalogMatches, initializeSongs, LOOKUP_RETRY_MS, lookupNextSong, SONG_SCHEMA_VERSION, SongStore } from '../src/utils/song-store.js';
import { recordingKey, sameLength } from '../src/utils/song-identity.js';

const HOUR = 60 * 60_000;
const quiet = { log() {}, error() {}, warn() {} };
const upload = (id, title, author, duration = 159_245) => ({ info: { identifier: id, uri: `https://www.youtube.com/watch?v=${id}`, sourceName: 'youtube', title, author, duration, isStream: false } });
const spotify = (id, title, author, duration, extra = {}) => ({
  info: { identifier: id, uri: `https://open.spotify.com/track/${id}`, sourceName: 'spotify', title, author, duration, isStream: false,
    isrc: 'USAT22300123', artworkUrl: 'https://i.scdn.co/image/abc', ...extra },
  pluginInfo: { albumName: 'The Crux' },
});

async function store(t, options = {}) {
  let clock = options.start ?? 1_800_000_000_000; let ids = 0;
  const songs = new SongStore(':memory:', { logger: quiet, now: () => clock, newId: () => `song:${++ids}`, ...options });
  await songs.open();
  t.after(() => songs.close());
  return { songs, advance: ms => { clock += ms; }, now: () => clock };
}

test('a recording key ignores how a song was uploaded and keeps which version it is', () => {
  const same = (a, b) => recordingKey(a) === recordingKey(b);
  const song = { title: 'End of Beginning', author: 'Djo' };
  assert.ok(same({ title: 'End of Beginning', author: 'Djo - Topic' }, song));
  assert.ok(same({ title: 'Djo - End of Beginning (Official Audio)', author: 'Djo' }, song));
  assert.ok(same({ title: 'Djo - End of Beginning [Lyric Video]', author: 'Some Channel' }, song));
  assert.ok(same({ title: 'End of Beginning (feat. Someone) | Official Video', author: 'DjoVEVO' }, song));
  assert.ok(same({ title: 'End of Beginning (Explicit)', author: 'Djo' }, song));
  for (const version of ['Live', 'Remix', 'Acoustic', 'Remastered 2011', 'Radio Edit', 'Clean', 'Sped Up', "Taylor's Version"]) {
    assert.ok(!same({ title: `End of Beginning (${version})`, author: 'Djo' }, song), version);
  }
  // Catalogs write versions after a dash; uploads put them in brackets.
  assert.ok(same({ title: 'Song - Remastered 2011', author: 'A' }, { title: 'Song (Remastered 2011)', author: 'A - Topic' }));
  assert.equal(recordingKey({ title: '(Official Video)', author: 'A' }), null);
  // An artist prefix goes first, even when the title starts with a version word.
  const oasis = { title: 'Live Forever', author: 'Oasis', sourceName: 'spotify' };
  assert.ok(same({ title: 'Oasis - Live Forever (Official Video)', author: 'Oasis' }, oasis));
  assert.ok(same({ title: 'Oasis - Live Forever (Official Video)', author: 'Some Channel' }, oasis));
  assert.ok(same({ title: 'Live Forever - Oasis', author: 'OasisVEVO' }, oasis));
  assert.ok(!same({ title: 'Oasis - Live Forever (Live at Knebworth)', author: 'Oasis' }, oasis));
  assert.ok(same({ title: 'Oasis - Live Forever - Live at Knebworth', author: 'Oasis' }, { title: 'Live Forever - Live at Knebworth', author: 'Oasis', sourceName: 'spotify' }));
  // Word boundaries count: these are different titles.
  assert.ok(!same({ title: 'Re-Creation', author: 'A' }, { title: 'Recreation', author: 'A' }));
  assert.equal(recordingKey({ title: "Taylor's Song", author: 'A' }), 'a|taylor s song');
});

test('the length rule allows 3 seconds or 2% of the shorter, whichever is smaller', () => {
  assert.ok(sameLength(200_000, 203_000));
  assert.ok(!sameLength(200_000, 203_001));
  assert.ok(sameLength(100_000, 102_000));
  assert.ok(!sameLength(100_000, 102_001));
  assert.ok(!sameLength(0, 0));
});

test('a played upload becomes a song with itself as its first source, once', async t => {
  const { songs, advance } = await store(t);
  const track = upload('Kf5pXDhx5Vc', 'End of Beginning', 'Djo - Topic');
  const id = songs.record(track);
  assert.equal(id, 'song:1');
  advance(HOUR);
  assert.equal(songs.record(track), 'song:1');
  const song = songs.songOf(track.info.uri);
  assert.equal(song.catalogStatus, 'pending');
  assert.deepEqual(song.sources, [{ uri: track.info.uri, sourceName: 'youtube', verification: 'first' }]);
  // Another upload of the same recording stays its own song until an audio match (a later step).
  assert.equal(songs.record(upload('aaaaaaaaaaa', 'Djo - End of Beginning (Official Audio)', 'Djo')), 'song:2');
  assert.equal(songs.record({ info: { ...track.info, uri: 'https://www.youtube.com/watch?v=livestream00', identifier: 'livestream00', isStream: true } }), null);
  assert.equal(songs.status().songs, 2);
});

test('a Spotify result links its own catalog entry and never becomes a source', async t => {
  const { songs } = await store(t);
  const track = spotify('4p8x', 'End of Beginning', 'Djo', 159_000);
  songs.record(track);
  const song = songs.songOf(track.info.uri);
  assert.equal(song.catalogStatus, 'linked');
  assert.deepEqual(song.sources, []);
  assert.deepEqual(song.catalog, { source: 'spotify', id: '4p8x', uri: track.info.uri, isrc: 'USAT22300123', title: 'End of Beginning',
    author: 'Djo', album: 'The Crux', artworkUrl: 'https://i.scdn.co/image/abc', duration: 159_000 });
  assert.deepEqual(songs.dueLookups(5), []);
});

test('a lookup links the first catalog result for the same recording and length', async t => {
  const { songs } = await store(t);
  const track = upload('Kf5pXDhx5Vc', 'Djo - End of Beginning (Official Audio)', 'Djo', 159_245);
  songs.record(track);
  const searched = [];
  const results = [
    spotify('live1', 'End of Beginning - Live', 'Djo', 159_000),
    spotify('long1', 'End of Beginning', 'Djo', 175_000),
    spotify('match', 'End of Beginning', 'Djo, Someone', 158_100),
  ];
  assert.equal(await lookupNextSong(songs, query => { searched.push(query); return { loadType: 'search', tracks: results }; }), true);
  assert.deepEqual(searched, ['Djo end of beginning']);
  const song = songs.songOf(track.info.uri);
  assert.equal(song.catalogStatus, 'linked');
  assert.equal(song.catalog.id, 'match');
  // Linking describes the song; the upload is still its only source.
  assert.equal(song.sources.length, 1);
  assert.equal(await lookupNextSong(songs, () => { throw new Error('not due'); }), false);
});

test('no matching catalog entry leaves the song unmatched for good', async t => {
  const { songs } = await store(t);
  const track = upload('bbbbbbbbbbb', 'Basement Demo', 'Small Band');
  songs.record(track);
  await lookupNextSong(songs, () => ({ loadType: 'search', tracks: [spotify('x', 'Basement Demo (Live)', 'Small Band', 159_000)] }));
  assert.equal(songs.songOf(track.info.uri).catalogStatus, 'unmatched');
  songs.record(track);
  assert.deepEqual(songs.dueLookups(5, Infinity), []);
});

test('failed lookups retry after 1, 6 and 24 hours, then daily, then when the song plays again', async t => {
  const { songs, advance } = await store(t);
  const track = upload('ccccccccccc', 'Song', 'Artist');
  songs.record(track);
  const failing = [() => { throw new Error('Lavalink unavailable'); }, () => ({ loadType: 'error', tracks: [] }), () => new Promise(() => {})];
  assert.deepEqual(LOOKUP_RETRY_MS.slice(0, 4), [HOUR, 6 * HOUR, 24 * HOUR, 24 * HOUR]);
  for (const [attempt, delay] of LOOKUP_RETRY_MS.entries()) {
    assert.equal(songs.dueLookups(1).length, 1, `attempt ${attempt}`);
    await lookupNextSong(songs, failing[attempt % failing.length], { timeoutMs: 5 });
    advance(delay - 1);
    assert.equal(songs.dueLookups(1).length, 0);
    advance(1);
  }
  // The last retry failed too: nothing is scheduled until the song plays.
  await lookupNextSong(songs, failing[0]);
  assert.deepEqual(songs.dueLookups(1, Infinity), []);
  songs.record(track);
  assert.equal(songs.dueLookups(1).length, 1);
  await lookupNextSong(songs, () => ({ loadType: 'search', tracks: [spotify('ok', 'Song', 'Artist', 159_245)] }));
  assert.equal(songs.songOf(track.info.uri).catalogStatus, 'linked');
});

test('songs unused for a year, or past the cap, are pruned with their references and sources', async t => {
  const { songs, advance, now } = await store(t, { limits: { songs: 2, retentionMs: 365 * 24 * HOUR, bytes: 32 * 1024 * 1024 } });
  const tracks = ['d', 'e', 'f'].map(letter => upload(letter.repeat(11), `Song ${letter}`, 'Artist'));
  for (const track of tracks) { songs.record(track); advance(1000); }
  songs.prune();
  assert.equal(songs.songOf(tracks[0].info.uri), null);
  assert.equal(songs.db.prepare('SELECT COUNT(*) AS n FROM sources').get().n, 2);
  advance(365 * 24 * HOUR);
  songs.record(tracks[2]);
  songs.prune(now());
  assert.equal(songs.songOf(tracks[1].info.uri), null);
  assert.ok(songs.songOf(tracks[2].info.uri));
  assert.equal(songs.db.prepare('SELECT COUNT(*) AS n FROM refs').get().n, 1);
});

test('catalog matching needs the same recording key and length', () => {
  const song = { title: 'End of Beginning', author: 'Djo - Topic', duration: 159_245 };
  assert.ok(catalogMatches(song, spotify('a', 'End of Beginning', 'Djo', 158_000)));
  assert.ok(!catalogMatches(song, spotify('b', 'End of Beginning', 'Djo', 155_000)));
  assert.ok(!catalogMatches(song, spotify('c', 'End of Beginning - Acoustic', 'Djo', 159_000)));
  assert.ok(!catalogMatches(song, spotify('d', 'End of Beginning', 'Someone Else', 159_000)));
});

test('an unavailable or newer store leaves playback untouched', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vybatron-songs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'songs.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const newer = new DatabaseSync(file); newer.exec(`PRAGMA user_version = ${SONG_SCHEMA_VERSION + 1}`); newer.close();
  const errors = [];
  const client = {};
  const songs = await initializeSongs(client, { dataDir: dir, logger: { log() {}, error: line => errors.push(line) } });
  assert.equal(client.songs, songs);
  assert.equal(songs.available, false);
  assert.equal(songs.record(upload('Kf5pXDhx5Vc', 'Song', 'Artist')), null);
  assert.equal(songs.songOf('https://www.youtube.com/watch?v=Kf5pXDhx5Vc'), null);
  assert.match(errors.join('\n'), /songs_unavailable/);
});

test('the store survives a restart and closes to a single file', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vybatron-songs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const client = { lavalink: null };
  const first = await initializeSongs(client, { dataDir: dir, logger: quiet });
  const track = upload('Kf5pXDhx5Vc', 'End of Beginning', 'Djo - Topic');
  const id = first.record(track);
  first.close();
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(dir).sort(), ['songs.sqlite']);
  const second = await initializeSongs(client, { dataDir: dir, logger: quiet });
  t.after(() => second.close());
  assert.equal(second.songOf(track.info.uri).id, id);
});
