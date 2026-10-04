import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LavalinkManager } from 'lavalink-client';
import { parseSpotifyUrl, parseSpotifyEmbed, matchSpotifyRecording, createSpotifyResolver } from '../src/utils/spotify.js';

const TRACK_ID = '3n3Ppam7vgaVa1iaRUc9Lp';
const ALBUM_ID = '4OHNH3sDzIxnmUADXzv2kT';
const PLAYLIST_ID = '37i9dQZF1DXcBWIGoYBM5M';
const url = (kind = 'track', id = TRACK_ID) => `https://open.spotify.com/${kind}/${id}`;
const recorded = JSON.parse(await readFile(new URL('./fixtures/spotify-public.json', import.meta.url), 'utf8'));
const copy = value => structuredClone(value);

function html(entity, data = {}) {
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: {
    entity, embeded_entity_uri: entity.uri, ...data,
  } } } } })}</script></html>`;
}

function youtube(title = 'Mr. Brightside', artist = 'The Killers', duration = 223_000, id = 'm2zUrruKjDQ') {
  return { encoded: `live-encoded-${id}`, requester: { id: '200' }, pluginInfo: {}, info: {
    title, author: artist, duration, identifier: id, uri: `https://www.youtube.com/watch?v=${id}`,
    sourceName: 'youtube', isStream: false, isSeekable: true,
  } };
}

function response(entity, options) { return new Response(html(entity), { headers: { 'content-type': 'text/html; charset=utf-8' }, ...options }); }
const trackMeta = () => parseSpotifyEmbed(html(recorded.track), url()).tracks[0];

test('Spotify addresses are canonicalized without fetching arbitrary hosts or paths', () => {
  const expected = parseSpotifyUrl(url());
  assert.deepEqual(parseSpotifyUrl(`${url()}?si=private-share-token#fragment`), expected);
  assert.deepEqual(parseSpotifyUrl(`https://open.spotify.com/intl-en/track/${TRACK_ID}`), expected);
  assert.deepEqual(parseSpotifyUrl(`spotify:track:${TRACK_ID}`), expected);
  for (const query of [
    `http://open.spotify.com/track/${TRACK_ID}`, `https://open.spotify.com.evil.test/track/${TRACK_ID}`,
    `https://user:password@open.spotify.com/track/${TRACK_ID}`, `https://open.spotify.com:9443/track/${TRACK_ID}`,
    `https://open.spotify.com/embed/track/${TRACK_ID}`, `https://open.spotify.com/track/${TRACK_ID}/anything`,
    'https://spotify.link/random', 'spotify:episode:3n3Ppam7vgaVa1iaRUc9Lp', 'spotify:track:short',
  ]) assert.equal(parseSpotifyUrl(query), null, query);
});

test('recorded public embed shape supplies identity and ordered collection rows while discarding previews and tokens', () => {
  const track = parseSpotifyEmbed(html(recorded.track, { accessToken: 'DO-NOT-RETAIN', defaultAudioFileObject: { url: 'secret-audio' } }), url());
  assert.deepEqual(track.tracks[0], { id: TRACK_ID, uri: `spotify:track:${TRACK_ID}`, url: url(),
    title: 'Mr. Brightside', artists: ['The Killers'], author: 'The Killers', duration: 222_200, isExplicit: false });
  assert.doesNotMatch(JSON.stringify(track), /preview|accessToken|DO-NOT-RETAIN|secret-audio/);
  assert.equal(track.partial, false);
  const album = parseSpotifyEmbed(html(recorded.album), url('album', ALBUM_ID));
  assert.equal(album.tracks[0].title, 'Jenny Was A Friend Of Mine');
  assert.equal(album.tracks[1].title, 'Somebody Told Me - Mylo Mix');
  assert.deepEqual(album.tracks[1].artists, ['The Killers', 'Mylo']);
  assert.equal(album.partial, true);
  const playlist = parseSpotifyEmbed(html(recorded.playlist), url('playlist', PLAYLIST_ID));
  assert.equal(playlist.tracks.length, recorded.playlist.trackList.length);
  assert.equal(playlist.partial, true);
  assert.equal(playlist.tracks[0].id, '11hcBLPtbMp4aQI6zGQLub');
});

test('wrong entity identity, incomplete shapes, duplicate data scripts and executable scripts are rejected', () => {
  for (const mutation of [
    entity => { entity.id = ALBUM_ID; }, entity => { entity.type = 'album'; },
    entity => { entity.uri = `spotify:track:${ALBUM_ID}`; }, entity => { entity.duration = '222200'; },
    entity => { entity.artists = []; }, entity => { entity.artists[0].name = null; },
    entity => { entity.isPlayable = false; }, entity => { entity.title = 'x'.repeat(251); },
  ]) { const entity = copy(recorded.track); mutation(entity); assert.throws(() => parseSpotifyEmbed(html(entity), url())); }
  assert.throws(() => parseSpotifyEmbed(html(recorded.track, { embeded_entity_uri: `spotify:track:${ALBUM_ID}` }), url()));
  const valid = html(recorded.track);
  assert.throws(() => parseSpotifyEmbed(valid + valid, url()));
  assert.throws(() => parseSpotifyEmbed(valid.replace('application/json', 'text/javascript'), url()));
  assert.throws(() => parseSpotifyEmbed(valid.replace('id="__NEXT_DATA__"', 'data-id="__NEXT_DATA__"'), url()));
  assert.throws(() => parseSpotifyEmbed('<script id="__NEXT_DATA__" type="application/json">bad json</script>', url()));
  assert.throws(() => parseSpotifyEmbed('x'.repeat(1024 * 1024 + 1), url()));
});

test('collection cap preserves listed order and skips invalid, unavailable or non-music rows', () => {
  const entity = copy(recorded.album);
  const valid = entity.trackList[0];
  entity.trackList = [valid, { ...valid, entityType: 'episode' }, { ...valid, uri: 'spotify:track:not-an-id' },
    { ...valid, subtitle: '' }, { ...valid, isPlayable: false }, ...Array.from({ length: 101 }, () => valid)];
  const catalog = parseSpotifyEmbed(html(entity), url('album', ALBUM_ID));
  assert.equal(catalog.listedCount, 106);
  assert.equal(catalog.tracks.length, 96);
  assert.equal(catalog.skippedMetadataCount, 4);
  assert.equal(catalog.capped, true);
  assert.equal(catalog.tracks[0].id, valid.uri.split(':')[2]);
  assert.ok(Object.isFrozen(catalog.tracks[0].artists));
});

test('matching prefers a full same-recording music result and retains recording version qualifiers', () => {
  const meta = trackMeta();
  const original = youtube();
  const exactLength = youtube('Mr. Brightside', 'The Killers - Topic', 222_000, 'l7MaKmKJqoc');
  assert.equal(matchSpotifyRecording(meta, [original, exactLength]), exactLength);
  assert.equal(matchSpotifyRecording(meta, [youtube('The Killers - Mr. Brightside (Official Audio)', 'TheKillersVEVO', 223_000)]).info.title,
    'The Killers - Mr. Brightside (Official Audio)');
  for (const bad of [
    youtube('Mr. Brightside (Cover)', 'The Killers'), youtube('Mr. Brightside (Live)', 'The Killers'),
    youtube('Mr. Brightside (Sped Up)', 'The Killers'), youtube('Mr. Brightside (Remastered)', 'The Killers'),
    youtube('Mr. Brightside (Clean)', 'The Killers'), youtube('Mr. Brightside', 'Unrelated Artist'),
    youtube('The Killers - Mr. Brightside (Lyrics)', 'Lost Panda'), youtube('Mr. Brightside', 'The Killers', 30_000),
    youtube('Mr. Brightside', 'The Killers', 235_000),
  ]) assert.equal(matchSpotifyRecording(meta, [bad]), null, JSON.stringify(bad.info));
  const remix = parseSpotifyEmbed(html(recorded.album), url('album', ALBUM_ID)).tracks[1];
  const remixResult = youtube('Somebody Told Me (Mylo Mix)', 'The Killers', 438_000, 'ySiWqduMPMo');
  assert.equal(matchSpotifyRecording(remix, [youtube('Somebody Told Me', 'The Killers', 198_000), remixResult]), remixResult);
  const live = { ...meta, title: 'Mr. Brightside - Live' };
  assert.equal(matchSpotifyRecording(live, [original]), null);
});

test('matching rejects an encoded preview, live stream, mismatched identity or non-YouTube source', () => {
  for (const mutation of [
    track => { track.encoded = ''; }, track => { track.info.sourceName = 'spotify'; },
    track => { track.info.isStream = true; }, track => { track.pluginInfo.isPreview = true; },
    track => { track.info.uri = `https://www.youtube.com/watch?v=l7MaKmKJqoc`; },
    track => { track.info.uri = 'https://preview.example/full.mp3'; }, track => { track.info.identifier = 'bad'; },
  ]) { const candidate = youtube(); mutation(candidate); assert.equal(matchSpotifyRecording(trackMeta(), [candidate]), null); }
});

test('resolver fetches only the canonical public embed and queues the original real YouTube track', async () => {
  const requests = []; const searches = [];
  const resolver = createSpotifyResolver({ fetchImpl: async (...args) => { requests.push(args); return response(recorded.track); } });
  const actual = youtube(); const requester = { id: '200' };
  const player = { search: async (...args) => { searches.push(args); return { tracks: [actual] }; } };
  const result = await resolver.search(player, `${url()}?si=private-cookie`, requester);
  assert.equal(result.loadType, 'track');
  assert.equal(result.tracks[0], actual);
  assert.match(result.spotifyImport.notice, /full recording/);
  assert.equal(requests[0][0], `https://open.spotify.com/embed/track/${TRACK_ID}`);
  assert.equal(requests[0][1].redirect, 'error');
  assert.deepEqual(requests[0][1].headers, { Accept: 'text/html' });
  assert.deepEqual(searches, [[{ query: 'The Killers Mr. Brightside', source: 'ytmsearch' }, requester]]);
  assert.equal(await resolver.search(player, 'https://malicious.test/track/id', requester), null);
  assert.equal(requests.length, 1);
});

test('an unmatched music result tries ordinary YouTube without guessing on title alone', async () => {
  const sources = [];
  const resolver = createSpotifyResolver({ fetchImpl: async () => response(recorded.track) });
  const actual = youtube('The Killers - Mr. Brightside (Official Audio)', 'TheKillersVEVO');
  const result = await resolver.search({ search: async query => { sources.push(query.source); return {
    tracks: [query.source === 'ytmsearch' ? youtube('Mr. Brightside', 'Different Artist') : actual],
  }; } }, url(), {});
  assert.deepEqual(sources, ['ytmsearch', 'ytsearch']);
  assert.equal(result.tracks[0], actual);
});

test('catalog artist names cannot override the fixed YouTube source or become arbitrary link requests', async () => {
  const manager = new LavalinkManager({ nodes: [], sendToShard() {}, client: { id: '100' } });
  for (const name of ['local:/etc/passwd', 'http://169.254.169.254', 'ftts:untrusted', 'spotify:malicious']) {
    const entity = copy(recorded.track); entity.artists[0].name = name;
    const resolver = createSpotifyResolver({ fetchImpl: async () => response(entity) });
    const searches = [];
    await resolver.search({ search: async query => { searches.push(manager.utils.transformQuery(query)); return { tracks: [] }; } }, url(), {});
    assert.deepEqual(searches.map(query => query.source), ['ytmsearch', 'ytsearch']);
    assert.ok(searches.every(query => !/^https?:\/\//i.test(query.query)));
  }
});

test('collections retain listed order despite concurrent results, skip unavailable rows, and disclose limits', async () => {
  const entity = copy(recorded.album);
  entity.trackList = Array.from({ length: 9 }, (_, index) => ({ ...entity.trackList[0], title: `Song ${index}` }));
  const resolver = createSpotifyResolver({ fetchImpl: async () => response(entity) });
  let active = 0; let peak = 0;
  const result = await resolver.search({ search: async query => {
    active++; peak = Math.max(peak, active);
    const index = Number(query.query.match(/Song (\d+)$/)[1]);
    await new Promise(resolve => setTimeout(resolve, (10 - index) * 2)); active--;
    return { tracks: index === 3 ? [] : [youtube(`Song ${index}`, 'The Killers', 245_000)] };
  } }, url('album', ALBUM_ID), {});
  assert.equal(peak, 4);
  assert.deepEqual(result.tracks.map(track => track.info.title), ['Song 0', 'Song 1', 'Song 2', 'Song 4', 'Song 5', 'Song 6', 'Song 7', 'Song 8']);
  assert.equal(result.spotifyImport.unavailableCount, 1);
  assert.equal(result.spotifyImport.remainingCount, 0);
  assert.equal(result.spotifyImport.partial, true);
  assert.match(result.spotifyImport.notice, /public listed tracks/);
  assert.match(result.spotifyImport.notice, /may omit tracks/);
  const playlist = await createSpotifyResolver({ fetchImpl: async () => response(recorded.playlist) }).search({ search: async () => ({ tracks: [] }) }, url('playlist', PLAYLIST_ID), {});
  assert.equal(playlist.loadType, 'empty');
  assert.match(playlist.spotifyImport.notice, /playlist may contain more tracks/);
});

test('metadata cache is bounded, expires, is immutable and retains neither failed lookups nor audio results', async () => {
  let time = 0; let calls = 0; let fail = false;
  const resolver = createSpotifyResolver({ now: () => time, fetchImpl: async address => {
    calls++;
    if (fail) return new Response('no', { status: 429 });
    const id = address.split('/').at(-1);
    return response({ ...recorded.track, id, uri: `spotify:track:${id}` });
  } });
  const first = await resolver.metadata(url());
  assert.throws(() => { first.tracks[0].title = 'pollute'; });
  await resolver.metadata(url()); assert.equal(calls, 1);
  time = 5 * 60_000; await resolver.metadata(url()); assert.equal(calls, 2);
  for (let index = 0; index < 101; index++) await resolver.metadata(url('track', index.toString().padStart(22, '0')));
  assert.equal(resolver.cacheSize(), 100);
  fail = true;
  const absent = url('track', 'Z'.repeat(22));
  await assert.rejects(resolver.metadata(absent)); await assert.rejects(resolver.metadata(absent));
  fail = false; await resolver.metadata(absent);
  assert.equal(resolver.cacheSize(), 100);
  resolver.clearCache(); assert.equal(resolver.cacheSize(), 0);
});

test('redirects, oversized bodies and wrong public media types fail without dispatching searches or caching', async () => {
  const oversize = 'x'.repeat(1024 * 1024 + 1);
  for (const fake of [
    new Response(html(recorded.track), { headers: { 'content-type': 'application/json' } }),
    new Response(oversize, { headers: { 'content-type': 'text/html' } }),
    new Response('small', { headers: { 'content-type': 'text/html', 'content-length': String(1024 * 1024 + 1) } }),
    response(recorded.track),
  ]) {
    let dispatched = false;
    if (fake.body && fake.headers.get('content-type') === 'text/html; charset=utf-8') Object.defineProperty(fake, 'url', { value: 'https://malicious.test' });
    const resolver = createSpotifyResolver({ fetchImpl: async () => fake });
    const result = await resolver.search({ search: async () => { dispatched = true; } }, url(), {});
    assert.equal(result.loadType, 'error'); assert.equal(dispatched, false); assert.equal(resolver.cacheSize(), 0);
  }
});

test('hung metadata and lookup requests are bounded and cannot insert late answers or spawn retry storms', async () => {
  let finishFetch;
  const metadataResolver = createSpotifyResolver({ metadataTimeoutMs: 10, fetchImpl: () => new Promise(resolve => { finishFetch = resolve; }) });
  const fetchResult = await metadataResolver.search({ search: async () => assert.fail('No metadata') }, url(), {});
  assert.equal(fetchResult.loadType, 'error'); assert.equal(metadataResolver.cacheSize(), 0);
  finishFetch(response(recorded.track)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(metadataResolver.cacheSize(), 0);
  const entity = copy(recorded.album);
  entity.trackList = Array.from({ length: 20 }, () => entity.trackList[0]);
  const late = []; let dispatched = 0;
  const resolver = createSpotifyResolver({ lookupTimeoutMs: 15, fetchImpl: async () => response(entity) });
  const result = await resolver.search({ search: () => { dispatched++; return new Promise(resolve => late.push(resolve)); } }, url('album', ALBUM_ID), {});
  assert.equal(dispatched, 4); assert.equal(result.tracks.length, 0);
  assert.equal(result.spotifyImport.remainingCount, 20);
  for (const complete of late) complete({ tracks: [youtube('Jenny Was A Friend Of Mine', 'The Killers', 244_000)] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatched, 4); assert.equal(result.tracks.length, 0);
});

test('whole-import deadline returns only completed matches and counts unfinished tracks', async () => {
  const entity = copy(recorded.album); entity.trackList = Array.from({ length: 8 }, () => entity.trackList[0]);
  let dispatched = 0;
  const resolver = createSpotifyResolver({ importTimeoutMs: 25, lookupTimeoutMs: 10_000, fetchImpl: async () => response(entity) });
  const result = await resolver.search({ search: async () => {
    dispatched++;
    if (dispatched === 1) return { tracks: [youtube('Jenny Was A Friend Of Mine', 'The Killers', 244_000)] };
    return new Promise(() => {});
  } }, url('album', ALBUM_ID), {});
  assert.equal(dispatched, 5); assert.equal(result.tracks.length, 1);
  assert.equal(result.spotifyImport.remainingCount, 7);
  assert.match(result.spotifyImport.notice, /import time limit/);
});

test('external cancellation prevents late results and cancelled public metadata never enters the cache', async () => {
  const controller = new AbortController(); let complete;
  const resolver = createSpotifyResolver({ fetchImpl: () => new Promise(resolve => { complete = resolve; }) });
  const pending = resolver.search({ search: async () => assert.fail('Cancelled') }, url(), {}, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending);
  complete(response(recorded.track)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolver.cacheSize(), 0);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(resolver.search({}, url(), {}, { signal: aborted.signal }));
});
