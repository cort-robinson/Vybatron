import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { portalFixture } from './portal-fixtures.js';
import { energyBins, waveform, mixCover } from '../src/utils/music-art.js';

test('only the visible player’s voice audience can read Activity metadata and measured music', async t => {
  const f = await portalFixture(t);
  const room = await f.request('/visualizer');
  assert.equal(room.status, 200);
  assert.equal(room.body.track.video, 'abcdefghijk');
  f.player.lastPosition = 1000;
  f.player.lastPositionChange = Date.now() - 10_000;
  f.player.filterManager = { data: { timescale: { speed: 1.25, rate: 1 } } };
  const clock = (await f.request('/visualizer')).body;
  assert.equal(clock.rate, 1.25);
  assert.ok(clock.positionMs >= 13500 && clock.positionMs < 15000);
  f.player.paused = true;
  assert.equal((await f.request('/visualizer')).body.positionMs, 1000);
  assert.deepEqual(Object.keys(room.body.track).sort(), ['artist','durationMs','id','title','video']);
  assert.equal((await f.request('/visualizer/lmnopqrstuv')).status, 404);
  f.members.get('200').voice.channel = f.channels.get('301');
  assert.equal((await f.request('/visualizer')).status, 403);
  assert.equal((await f.request('/visualizer/abcdefghijk')).status, 403);
  f.members.get('200').voice.channel = f.channels.get('300');
  f.channels.get('400').hidden.add('200');
  assert.equal((await f.request('/visualizer')).status, 403);
});

test('measured quiet and loud sections and the playhead survive encoding; missing covers still compose', async () => {
  const bins = energyBins({ frameCount: 2, bandCount: 2, levels: Buffer.from([0,0,255,255]).toString('base64') }, 2);
  assert.deepEqual(bins, [0,1]);
  const image = await sharp(waveform({ bins, color: [125,200,100] }, .5)).raw().toBuffer({ resolveWithObject: true });
  assert.equal(image.info.width, 10);
  assert.deepEqual([...image.data.subarray(5 * 3, 5 * 3 + 3)], [250,250,250]);
  assert.equal((await sharp(await mixCover([])).metadata()).width, 256);
});
