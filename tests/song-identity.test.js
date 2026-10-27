import test from 'node:test';
import assert from 'node:assert/strict';
import { isYouTubeMusicSong, referenceRank, songIdentity, songKey } from '../src/utils/song-identity.js';

const yt = (title, author, extra = {}) => ({ title, author, sourceName: 'youtube', identifier: 'abcdefghijk', uri: 'https://www.youtube.com/watch?v=abcdefghijk', ...extra });
const sameSong = (references) => {
  const keys = references.map(([title, author, extra]) => songKey(yt(title, author, extra)));
  assert.equal(new Set(keys).size, 1, `expected one song, got ${JSON.stringify(keys)}`);
  return keys[0];
};

test('topic uploads, official videos, lyric videos and audio uploads are one song', () => {
  sameSong([
    ['Anti-Hero', 'Taylor Swift - Topic'],
    ['Taylor Swift - Anti-Hero (Official Music Video)', 'TaylorSwiftVEVO'],
    ['Taylor Swift - Anti-Hero (Lyrics)', '7clouds'],
    ['Taylor Swift - Anti-Hero [Official Audio]', 'Taylor Swift'],
    ['Taylor Swift – Anti-Hero (Official Lyric Video) [HD]', 'Taylor Swift'],
    ['Anti-Hero | Taylor Swift | Official Video', 'Taylor Swift'],
    ['Anti-Hero', 'Taylor Swift', { sourceName: 'spotify' }],
  ]);
});

test('feat. credits in the title or artist do not split a song', () => {
  sameSong([
    ['This Is What You Came For (feat. Rihanna)', 'Calvin Harris - Topic'],
    ['Calvin Harris - This Is What You Came For (Official Video) ft. Rihanna', 'CalvinHarrisVEVO'],
    ['Calvin Harris feat. Rihanna - This Is What You Came For', 'Ultra Music'],
    ['This Is What You Came For [feat. Rihanna]', 'Calvin Harris, Rihanna'],
    ['This Is What You Came For featuring Rihanna', 'Calvin Harris'],
  ]);
});

test('remaster and upload descriptors merge; real versions stay distinct', () => {
  const original = sameSong([
    ['Here Comes The Sun - Remastered 2019', 'The Beatles - Topic'],
    ['Here Comes The Sun (Remastered 2009)', 'The Beatles'],
    ['The Beatles - Here Comes The Sun (Official Audio)', 'The Beatles'],
  ]);
  for (const version of ['Here Comes The Sun (Live)', 'Here Comes The Sun (Acoustic)', 'Here Comes The Sun (Remix)', 'Here Comes The Sun (Sped Up)', 'Here Comes The Sun (Cover)']) {
    assert.notEqual(songKey(yt(version, 'The Beatles - Topic')), original, version);
  }
});

test('accents, apostrophes, ampersands and multi-artist credits normalize consistently', () => {
  sameSong([['Halo', 'Beyonce - Topic'], ['Beyoncé - Halo', 'BeyonceVEVO']]);
  sameSong([['Don’t Stop Me Now', 'Queen - Topic'], ["Queen - Don't Stop Me Now (Official Video)", 'Queen Official']]);
  const key = sameSong([['The Sound of Silence', 'Simon & Garfunkel - Topic'], ['Simon & Garfunkel - The Sound of Silence (Audio)', 'SimonGarfunkelVEVO']]);
  assert.equal(songIdentity(yt('The Sound of Silence', 'Simon & Garfunkel - Topic')).artist, 'Simon & Garfunkel');
  assert.match(key, /^simon\|/);
});

test('titles that only look like descriptors keep their meaning', () => {
  assert.equal(songKey(yt('Video Killed the Radio Star', 'The Buggles - Topic')), songKey(yt('The Buggles - Video Killed The Radio Star (Official Music Video)', 'The Buggles')));
  assert.equal(songKey(yt('Mr. Clean', 'Someone')), 'someone|mrclean');
  assert.equal(songKey(yt('Paparazzi Official Video', 'Lady Gaga')), 'ladygaga|paparazzi');
  assert.equal(songKey(yt('Song - Artist', 'Artist')), 'artist|song');
});

test('different songs and different artists never collide', () => {
  assert.notEqual(songKey(yt('Halo', 'Beyonce - Topic')), songKey(yt('Halo', 'Depeche Mode - Topic')));
  assert.notEqual(songKey(yt('Halo', 'Beyonce - Topic')), songKey(yt('Single Ladies', 'Beyonce - Topic')));
});

test('identity is pure, bounded and falls back to the catalog ID when no title remains', () => {
  const reference = yt('(Official Video)', 'Someone', { identifier: 'zzzzzzzzzzz' });
  assert.equal(songKey(reference), 'id:youtube:zzzzzzzzzzz');
  assert.equal(songKey(reference), songKey({ ...reference }));
  assert.ok(songKey(yt('x'.repeat(5000), 'y'.repeat(5000))).length <= 200);
  assert.equal(songKey({}), 'id:unknown:');
});

test('reference rank prefers topic uploads, then official audio, then videos, then Spotify mirrors', () => {
  const topic = referenceRank(yt('Anti-Hero', 'Taylor Swift - Topic'));
  const audio = referenceRank(yt('Taylor Swift - Anti-Hero (Official Audio)', 'Taylor Swift'));
  const plain = referenceRank(yt('Anti-Hero', 'Taylor Swift'));
  const video = referenceRank(yt('Taylor Swift - Anti-Hero (Official Music Video)', 'TaylorSwiftVEVO'));
  const spotify = referenceRank(yt('Anti-Hero', 'Taylor Swift', { sourceName: 'spotify' }));
  assert.ok(topic > audio && audio > plain && plain > video && video > spotify, JSON.stringify({ topic, audio, plain, video, spotify }));
  assert.equal(referenceRank(yt('Live radio', 'Station', { isStream: true })), 0);
});

test('a YouTube Music song result ranks with topic uploads, above official audio videos', () => {
  const music = { info: yt('Chicago', 'Michael Jackson', { artworkUrl: 'https://yt3.googleusercontent.com/AbC_dEf-GhIjKlMnOpQrStUv=w1000-h1000' }) };
  assert.equal(isYouTubeMusicSong(music), true);
  assert.equal(isYouTubeMusicSong({ info: { ...music.info, artworkUrl: 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg' } }), false);
  assert.equal(isYouTubeMusicSong({ info: { ...music.info, sourceName: 'soundcloud' } }), false);
  const song = referenceRank(music.info, { youtubeMusic: true });
  assert.equal(song, referenceRank(yt('Chicago', 'Michael Jackson - Topic')));
  assert.ok(song > referenceRank(yt('Michael Jackson - Chicago (Official Audio)', 'michaeljacksonVEVO')));
});
