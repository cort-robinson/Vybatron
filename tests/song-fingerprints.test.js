import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FINGERPRINT, fingerprintOf, sameAudio, similarity } from '../src/utils/fingerprint.js';
import { alternateCandidates, measureWith, startSongJobs } from '../src/utils/song-jobs.js';
import { MIGRATIONS, SOURCE_COOLDOWN_MS, SongStore } from '../src/utils/song-store.js';

const HOUR = 60 * 60_000;
const quiet = { log() {}, error() {}, warn() {} };
const calibration = JSON.parse(readFileSync(new URL('./fixtures/fingerprints.json', import.meta.url)));
const print = id => Buffer.from(calibration.fingerprints[id], 'base64');
const upload = (id, title, author, duration = 159_245) => ({ encoded: `enc-${id}`, info: { identifier: id, uri: `https://www.youtube.com/watch?v=${id}`, sourceName: 'youtube', title, author, duration, isStream: false } });
// A synthetic energy map: 16 bands at 30 frames a second with a recognisable shape.
const levels = (seconds, seed = 1, offsetFrames = 0) => {
  const frames = seconds * 30; const out = new Uint8Array(frames * 16);
  for (let f = 0; f < frames; f++) for (let b = 0; b < 16; b++) out[f * 16 + b] = Math.round(127 + 120 * Math.sin((f + offsetFrames) * seed / 37 + b * .7) * Math.cos((f + offsetFrames) / 211 + seed));
  return { levels: out, frames };
};

async function store(t, options = {}) {
  let clock = 1_800_000_000_000; let ids = 0;
  const songs = new SongStore(':memory:', { logger: quiet, now: () => clock, newId: () => `song:${++ids}`, ...options });
  await songs.open();
  t.after(() => songs.close());
  return { songs, advance: ms => { clock += ms; }, now: () => clock };
}

test('the calibration pairs land on the right side of the threshold', () => {
  for (const [a, b, label] of calibration.same) assert.ok(similarity(print(a), print(b)) >= FINGERPRINT.threshold + .05, label);
  for (const [a, b, label] of calibration.different) assert.ok(similarity(print(a), print(b)) < FINGERPRINT.threshold - .15, label);
  // Masters apart only in mastering or a few words match: titles have to keep them apart.
  for (const [a, b, label] of calibration.titled) assert.ok(sameAudio(print(a), print(b)), label);
});

test('a fingerprint is at most 2 KB and allows for a shifted start', () => {
  const long = levels(600);
  assert.equal(fingerprintOf(long.levels, long.frames).length, FINGERPRINT.columns * FINGERPRINT.bands);
  assert.ok(FINGERPRINT.columns * FINGERPRINT.bands <= 2048);
  assert.equal(fingerprintOf(levels(5).levels, 150), null);
  const a = levels(200); const late = levels(200, 1, -45); const other = levels(200, 3);
  const fa = fingerprintOf(a.levels, a.frames);
  assert.ok(similarity(fa, fingerprintOf(late.levels, late.frames)) > .99, '1.5 seconds of extra lead-in');
  assert.ok(similarity(fa, fingerprintOf(other.levels, other.frames)) < .5);
  assert.equal(similarity(fa, Buffer.alloc(3)), -1);
});

test('a version 1 store gains fingerprints, verified sources and aliases', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vybatron-songs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'songs.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(file);
  old.exec(MIGRATIONS[0]); old.exec('PRAGMA user_version = 1');
  const at = Date.now();
  old.prepare(`INSERT INTO songs (id, title, artist, duration, created_at, used_at, catalog_status, next_lookup_at) VALUES ('song:old', 'Song', 'Artist', 200000, ?, ?, 'pending', ?)`).run(at, at, at);
  old.prepare(`INSERT INTO refs VALUES ('https://www.youtube.com/watch?v=aaaaaaaaaaa', 'song:old', ?)`).run(at);
  old.prepare(`INSERT INTO sources VALUES ('https://www.youtube.com/watch?v=aaaaaaaaaaa', 'song:old', 'youtube', 'aaaaaaaaaaa', 'Song', 'Artist', 200000, 'first', ?)`).run(at);
  old.close();
  const songs = new SongStore(file, { logger: quiet });
  await songs.open(); t.after(() => songs.close());
  assert.equal(songs.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.deepEqual(songs.songOf('https://www.youtube.com/watch?v=aaaaaaaaaaa').sources, [{ uri: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', sourceName: 'youtube', verification: 'first' }]);
  assert.deepEqual(songs.fingerprintDue(), { id: 'song:old', identifier: 'aaaaaaaaaaa' });
});

test('fingerprints are measured once, retried after a failure, and kept for the most used songs only', async t => {
  const { songs, advance } = await store(t, { limits: { songs: 50, sources: 8, fingerprints: 1, retentionMs: 365 * 24 * HOUR, bytes: 32 * 1024 * 1024 } });
  songs.record(upload('aaaaaaaaaaa', 'One', 'A'));
  assert.equal(songs.fingerprintDue().id, 'song:1');
  songs.setFingerprint('song:1', null);
  assert.equal(songs.fingerprintDue(), null);
  advance(SOURCE_COOLDOWN_MS);
  songs.setFingerprint('song:1', Buffer.from([1, 2, 3, 4]));
  assert.equal(songs.fingerprintDue(), null);
  advance(1000); songs.record(upload('bbbbbbbbbbb', 'Two', 'B'));
  // Only one song may keep a fingerprint: the newer one is due, the older loses its own at prune.
  assert.equal(songs.fingerprintDue().id, 'song:2');
  songs.prune();
  assert.equal(songs.db.prepare('SELECT COUNT(*) AS n FROM songs WHERE fingerprint IS NOT NULL').get().n, 0);
});

test('a verified upload joins the song, and an upload that was its own song merges into the older one', async t => {
  const { songs, advance } = await store(t);
  const first = upload('aaaaaaaaaaa', 'End of Beginning', 'Djo - Topic');
  songs.record(first);
  advance(1000);
  const later = upload('bbbbbbbbbbb', 'Djo - End Of Beginning (Official Audio)', 'Djo Music');
  songs.record(later);
  songs.resolveLookup('song:2', [{ info: { identifier: 'sp1', uri: 'https://open.spotify.com/track/sp1', sourceName: 'spotify', title: 'End of Beginning', author: 'Djo', duration: 159_500, isrc: 'USAT22300123' }, pluginInfo: {} }]);
  songs.setFingerprint('song:1', Buffer.from([1, 2, 3, 4]));
  assert.equal(songs.addVerifiedSource('song:1', upload('ccccccccccc', 'Djo - End of Beginning (Lyrics)', 'Some Channel'), .97), 'song:1');
  // The second upload's song turns out to be the same recording.
  assert.equal(songs.addVerifiedSource('song:2', first, .99), 'song:1');
  const song = songs.songOf(later.info.uri);
  assert.equal(song.id, 'song:1');
  assert.deepEqual(song.sources.map(source => [source.uri.slice(-11), source.verification]), [['aaaaaaaaaaa', 'first'], ['bbbbbbbbbbb', 'first'], ['ccccccccccc', 'audio']]);
  // The survivor had no catalog link and takes the merged song's.
  assert.equal(song.catalog.isrc, 'USAT22300123');
  assert.deepEqual(songs.db.prepare('SELECT alias, song_id FROM aliases').all().map(row => ({ ...row })), [{ alias: 'song:2', song_id: 'song:1' }]);
  assert.equal(songs.status().songs, 1);
  // Catalog entries and streams are never sources.
  assert.equal(songs.addVerifiedSource('song:1', { info: { identifier: 'sp2', uri: 'https://open.spotify.com/track/sp2', sourceName: 'spotify', title: 'x', author: 'y', duration: 1000 } }, 1), null);
});

test('a song keeps at most its source budget', async t => {
  const { songs } = await store(t, { limits: { songs: 50, sources: 2, fingerprints: 10, retentionMs: 365 * 24 * HOUR, bytes: 32 * 1024 * 1024 } });
  songs.record(upload('aaaaaaaaaaa', 'Song', 'A'));
  songs.addVerifiedSource('song:1', upload('bbbbbbbbbbb', 'Song', 'A'), .9);
  songs.addVerifiedSource('song:1', upload('ccccccccccc', 'Song', 'A'), .9);
  assert.equal(songs.songOf('https://www.youtube.com/watch?v=aaaaaaaaaaa').sources.length, 2);
});

test('playback tries the last success, then Topic uploads, and skips a recent failure for six hours', async t => {
  const { songs, advance } = await store(t);
  const [a, b, c] = [upload('aaaaaaaaaaa', 'Song', 'A'), upload('bbbbbbbbbbb', 'Song', 'A - Topic'), upload('ccccccccccc', 'Song (Audio)', 'A')];
  songs.record(a);
  songs.addVerifiedSource('song:1', c, .95); advance(1); songs.addVerifiedSource('song:1', b, .95);
  const order = () => songs.playbackSources(a.info.uri).map(source => source.identifier[0]);
  // The upload that played comes first, then the Topic upload, then the rest.
  assert.deepEqual(order(), ['a', 'b', 'c']);
  advance(1); songs.sourceResult(c.info.uri, true);
  assert.deepEqual(order(), ['c', 'a', 'b']);
  advance(1); songs.sourceResult(c.info.uri, false);
  assert.deepEqual(order(), ['a', 'b']);
  advance(SOURCE_COOLDOWN_MS);
  assert.deepEqual(order(), ['c', 'a', 'b']);
  assert.deepEqual(songs.playbackSources('https://www.youtube.com/watch?v=unknown0000'), []);
});

test('alternate candidates need the same recording and length and are new to the song', () => {
  const song = { title: 'End of Beginning', author: 'Djo - Topic', duration: 159_245, sources: ['https://www.youtube.com/watch?v=Kf5pXDhx5Vc'] };
  const results = [upload('Kf5pXDhx5Vc', 'End of Beginning', 'Djo'), upload('xy3AcmW0lrQ', 'Djo - End Of Beginning (Official Audio)', 'Djo Music', 160_000),
    upload('VfPdynN2FXw', 'Djo - End Of Beginning (Demo Version)', 'Djo Music', 165_000), upload('VObmpZL8HOk', 'End Of Beginning - Djo (Radio Edit)', 'Radio Effects', 184_000),
    upload('oXSw8DGjf5E', 'Djo - End of Beginning (Official Visualiser)', 'Djo Music', 160_000), upload('B3Z4XGAxJB0', 'Djo - End Of Beginning (Lyrics)', 'Dan Music', 160_000),
    upload('F83cNZG3MzE', 'Djo - End Of Beginning (Lyrics)', '7clouds Indie', 160_000)];
  assert.deepEqual(alternateCandidates(song, results).map(track => track.info.identifier), ['xy3AcmW0lrQ', 'oXSw8DGjf5E', 'B3Z4XGAxJB0']);
});

test('measuring waits for a pending analysis, and an unavailable song measures as nothing', async () => {
  const ready = { status: 'ready', frameCount: 600, levels: Buffer.from(levels(20).levels).toString('base64') };
  const answers = [{ status: 'pending', retryMs: 1 }, ready];
  const measure = measureWith({ get: async () => answers.shift() }, { wait: async () => {} });
  assert.equal((await measure('aaaaaaaaaaa')).length, 40 * 4);
  assert.equal(await measureWith({ get: async () => { throw Object.assign(new Error('x'), { status: 404 }); } })('aaaaaaaaaaa'), null);
  await assert.rejects(measureWith({ get: async () => { throw Object.assign(new Error('x'), { status: 429, code: 'busy' }); } })('aaaaaaaaaaa'));
});

test('the jobs record a device play, fingerprint it, and verify only an alternate whose audio matches', async t => {
  const { songs, advance } = await store(t);
  const client = { songs };
  const original = upload('xy3AcmW0lrQ', 'Djo - End Of Beginning (Official Audio)', 'Djo Music', 160_000);
  const visualiser = upload('oXSw8DGjf5E', 'Djo - End of Beginning (Official Visualiser)', 'Djo Music', 160_000);
  const lookalike = upload('lookalike01', 'Djo - End of Beginning', 'Djo', 160_500);
  const fingerprints = { xy3AcmW0lrQ: print('xy3AcmW0lrQ'), oXSw8DGjf5E: print('oXSw8DGjf5E'), lookalike01: print('VfPdynN2FXw') };
  const searches = []; const measured = [];
  const search = async (query, source) => {
    searches.push([query, source]);
    if (query === original.info.uri) return { loadType: 'track', tracks: [original] };
    return { loadType: 'search', tracks: [original, visualiser, lookalike] };
  };
  const jobs = startSongJobs(client, { measure: async id => { measured.push(id); return fingerprints[id] ?? null; }, search, intervalMs: 3_600_000, now: () => Date.now(), logger: quiet });
  t.after(() => jobs.stop());
  jobs.devicePlayed('xy3AcmW0lrQ'); jobs.devicePlayed('xy3AcmW0lrQ');
  await jobs.tick();
  assert.equal(songs.songOf(original.info.uri).sources.length, 1);
  await jobs.tick();
  assert.deepEqual(measured, ['xy3AcmW0lrQ']);
  await jobs.tick();
  assert.deepEqual(measured, ['xy3AcmW0lrQ', 'oXSw8DGjf5E', 'lookalike01']);
  assert.deepEqual(searches.at(-1), ['Djo end of beginning', 'ytmsearch']);
  const song = songs.songOf(original.info.uri);
  assert.deepEqual(song.sources.map(source => [source.uri.slice(-11), source.verification]).sort(), [['oXSw8DGjf5E', 'audio'], ['xy3AcmW0lrQ', 'first']]);
  // Checked: nothing is due again until the recheck interval.
  assert.equal(songs.alternatesDue(), null);
  advance(0);
});

test('a failed search leaves the song to be checked again in six hours', async t => {
  const { songs, advance } = await store(t);
  songs.record(upload('aaaaaaaaaaa', 'Song', 'Artist'));
  songs.setFingerprint('song:1', print('xy3AcmW0lrQ'));
  const jobs = startSongJobs({ songs }, { measure: async () => null, search: async () => ({ loadType: 'error' }), intervalMs: 3_600_000, logger: quiet });
  t.after(() => jobs.stop());
  await jobs.tick(); await jobs.tick();
  assert.equal(songs.alternatesDue(), null);
  advance(6 * HOUR);
  assert.equal(songs.alternatesDue().id, 'song:1');
});

test('a check that merges its song into an older one carries on as the older song', async t => {
  const { songs, advance } = await store(t);
  const older = upload('olderSong01', 'Djo - End Of Beginning (Official Audio)', 'Djo Music', 160_000);
  songs.record(older); advance(1000);
  const newer = upload('newerSong01', 'Djo - End of Beginning (Official Visualiser)', 'Djo Music', 160_000);
  songs.record(newer);
  songs.setFingerprint('song:2', print('xy3AcmW0lrQ'));
  const lyrics = upload('lyricSong01', 'Djo - End Of Beginning (Lyrics)', 'Dan Music', 160_000);
  const jobs = startSongJobs({ songs }, { measure: async () => print('xy3AcmW0lrQ'), search: async () => ({ loadType: 'search', tracks: [older, lyrics] }), intervalMs: 3_600_000, logger: quiet });
  t.after(() => jobs.stop());
  // song:1's fingerprint failed, so one tick checks song:2's alternates; a second would hide the bug.
  songs.setFingerprint('song:1', null);
  await jobs.tick();
  const song = songs.songOf(newer.info.uri);
  assert.equal(song.id, 'song:1');
  assert.deepEqual(song.sources.map(source => source.uri.slice(-11)).sort(), ['lyricSong01', 'newerSong01', 'olderSong01']);
  assert.equal(songs.alternatesDue(), null);
});

test('a merge keeps the source budget and every URL mapping', async t => {
  const { songs, advance } = await store(t, { limits: { sources: 3 } });
  const a = ['aaaaaaaaaa1', 'aaaaaaaaaa2'].map(id => upload(id, 'Song', 'A'));
  const b = ['bbbbbbbbbb1', 'bbbbbbbbbb2'].map(id => upload(id, 'Song', 'A'));
  songs.record(a[0]); songs.addVerifiedSource('song:1', a[1], .9); advance(1);
  songs.record(b[0]); songs.addVerifiedSource('song:2', b[1], .9);
  songs.addVerifiedSource('song:2', a[0], .95);
  assert.equal(songs.db.prepare("SELECT COUNT(*) AS n FROM sources WHERE song_id = 'song:1'").get().n, 3);
  for (const track of [...a, ...b]) assert.equal(songs.songOf(track.info.uri).id, 'song:1');
});

test('a measurement that fails for a temporary reason waits six hours instead of retrying every tick', async t => {
  const { songs, advance } = await store(t);
  songs.record(upload('aaaaaaaaaaa', 'Song', 'Artist'));
  let measured = 0;
  const jobs = startSongJobs({ songs }, { measure: async () => { measured++; throw Object.assign(new Error('busy'), { status: 429 }); }, search: async () => null, intervalMs: 3_600_000, logger: quiet });
  t.after(() => jobs.stop());
  await jobs.tick(); await jobs.tick(); await jobs.tick();
  assert.equal(measured, 1);
  advance(SOURCE_COOLDOWN_MS);
  assert.equal(songs.fingerprintDue().id, 'song:1');
});

test('a device play whose lookup fails is looked up again later', async t => {
  const { songs } = await store(t);
  let clock = 1_000_000; let failing = true;
  const track = upload('xy3AcmW0lrQ', 'Djo - End Of Beginning (Official Audio)', 'Djo Music', 160_000);
  const jobs = startSongJobs({ songs }, { measure: async () => null, now: () => clock, intervalMs: 3_600_000, logger: quiet,
    search: async () => (failing ? { loadType: 'error' } : { loadType: 'track', tracks: [track] }) });
  t.after(() => jobs.stop());
  jobs.devicePlayed('xy3AcmW0lrQ');
  await jobs.tick();
  assert.equal(songs.songOf(track.info.uri), null);
  failing = false; clock += 10 * 60_000;
  await jobs.tick();
  assert.ok(songs.songOf(track.info.uri));
});

test('a YouTube Music song that names its artist sorts with Topic uploads', async t => {
  const { songs } = await store(t);
  const music = upload('musicSong01', 'End of Beginning', 'Djo');
  music.info.artworkUrl = 'https://lh3.googleusercontent.com/abc';
  const lyrics = upload('lyricSong01', 'Djo - End Of Beginning (Lyrics)', 'Dan Music');
  const played = upload('playedSong1', 'Djo - End Of Beginning (Official Audio)', 'Djo Music');
  songs.record(played);
  songs.addVerifiedSource('song:1', lyrics, .98);
  songs.addVerifiedSource('song:1', music, .98);
  // After the source that played, a Music song comes before an older lyric upload.
  assert.deepEqual(songs.playbackSources(played.info.uri).map(source => source.identifier), ['playedSong1', 'musicSong01', 'lyricSong01']);
});

test('an upload first seen plainly is recognised as a Music song when it shows up as one', async t => {
  const { songs } = await store(t);
  const lyrics = upload('lyricSong01', 'Djo - End Of Beginning (Lyrics)', 'Dan Music');
  const plain = upload('musicSong01', 'End of Beginning', 'Djo');
  const music = upload('musicSong01', 'End of Beginning', 'Djo');
  music.info.artworkUrl = 'https://lh3.googleusercontent.com/abc';
  songs.record(lyrics); songs.record(plain);
  // Neither has played as a source of song:1 yet; only Music recognition can order them.
  songs.db.exec('UPDATE sources SET last_played_at = NULL');
  songs.addVerifiedSource('song:1', music, .98);
  assert.deepEqual(songs.playbackSources(lyrics.info.uri).map(source => source.identifier), ['musicSong01', 'lyricSong01']);
});
