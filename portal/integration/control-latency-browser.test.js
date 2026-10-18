// Compiled browsers and real OAuth/API/adapter. Only Discord/audio are fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPortalServer } from '../server/src/app.js';
import { loadConfig } from '../server/src/config.js';
import { portalFixture } from '../../tests/portal-fixtures.js';
import { cssScene } from './css-scene.mjs';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const { chromium, expect } = createRequire(path.join(web, 'package.json'))('@playwright/test');
async function freePort() {
  const server = http.createServer(); server.listen(0, '127.0.0.1');
  await once(server, 'listening'); const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}

test('another compiled device receives Pause promptly without waiting for the periodic poll', { timeout: 40_000 }, async t => {
  const bot = await portalFixture(t);
  for (const user of bot.users.values()) user.displayAvatarURL = () => null;
  const origin = `http://127.0.0.1:${await freePort()}`;
  let app; let browser;
  const discord = http.createServer(async (req, res) => {
    if (req.url.startsWith('/authorize?')) {
      const state = new URL(req.url, 'http://discord.fixture').searchParams.get('state');
      res.writeHead(302, { location: origin + '/auth/discord/callback?code=latency-fixture&state=' + state });
      res.end(); return;
    }
    for await (const _ of req) { /* controlled external OAuth reply */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/token'
      ? { access_token: 'synthetic-latency-token', token_type: 'Bearer', scope: 'identify' }
      : { id: '200', username: 'listener' }));
  });
  t.after(async () => {
    try { await browser?.close(); } finally {
      try { await app?.close(); } finally {
        discord.closeAllConnections(); if (discord.listening) await new Promise(resolve => discord.close(resolve));
      }
    }
  });
  discord.listen(0, '127.0.0.1'); await once(discord, 'listening');
  const discordOrigin = `http://127.0.0.1:${discord.address().port}`;
  const secret = 'independent-latency-fixture-secret-12345678';
  app = await createPortalServer({ ...loadConfig({ NODE_ENV: 'test', PORTAL_ORIGIN: origin,
    PORTAL_BOT_URL: bot.origin, PORTAL_BRIDGE_TOKEN: bot.token, DISCORD_CLIENT_SECRET: secret,
    DISCORD_CLIENT_ID: '123456789012345678', PORTAL_SESSION_SECRET: secret,
    PORTAL_DATA_DIR: path.join(bot.dir, 'latency-auth'), PORTAL_WEB_DIST: path.join(web, 'dist'),
    PORTAL_PORT: String(new URL(origin).port) }), discordAuthorizeUrl: discordOrigin + '/authorize' },
  { discordOrigin, limits: { pollMs: 60_000 } });
  const requests = []; let pauseReplyAt = 0;
  app.server.prependListener('request', (req, res) => {
    const resource = new URL(req.url, origin).pathname;
    requests.push({ method: req.method, resource });
    if (req.method === 'POST' && resource === '/api/guilds/100/commands')
      res.once('finish', () => { if (res.statusCode === 200) pauseReplyAt = performance.now(); });
  });
  await app.listen();
  browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' });
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1488, height: 1056 }, reducedMotion: 'reduce' }),
    browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' }),
  ]);
  await Promise.all(contexts.map(context => context.addInitScript(cssScene)));
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  let observerStreams = 0, actingStreams = 0, actingSnapshotReads = 0;
  pages[0].on('request', request => {
    const resource = new URL(request.url()).pathname;
    if (resource === '/api/guilds/100/events') actingStreams++;
    if (request.method() === 'GET' && resource === '/api/guilds/100') actingSnapshotReads++;
  });
  pages[1].on('request', request => { if (new URL(request.url()).pathname === '/api/guilds/100/events') observerStreams++; });
  for (const page of pages) {
    await page.goto(origin);
    await page.getByRole('link', { name: /Continue with Discord/ }).click();
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  }
  await expect.poll(() => app.resourceCounts().streams).toBe(2);
  const streamReads = observerStreams;
  const actingStreamReads = actingStreams, snapshotReads = actingSnapshotReads;
  await pages[0].getByRole('button', { name: 'Pause playback' }).click();
  await expect(pages[0].getByRole('button', { name: 'Resume playback' })).toBeEnabled({ timeout: 2000 });
  await expect(pages[1].getByRole('button', { name: 'Resume playback' })).toBeEnabled({ timeout: 2000 });
  assert.ok(pauseReplyAt > 0);
  const propagationMs = Math.round(performance.now() - pauseReplyAt);
  assert.ok(propagationMs < 2000, 'Other device updates without a 60-second poll');
  t.diagnostic(JSON.stringify({ serverReplyToOtherDeviceMs: propagationMs, periodicPollMs: 60_000 }));
  assert.equal(bot.player.paused, true);
  assert.equal(bot.calls.filter(call => call === 'pause').length, 1);
  assert.equal(requests.filter(r => r.method === 'POST' && r.resource.endsWith('/commands')).length, 1);
  assert.equal(observerStreams, streamReads,
    'Successful update must keep the observing device stream open');
  assert.equal(actingStreams, actingStreamReads,
    'Ordered successful reply must keep the acting device stream open');
  assert.equal(actingSnapshotReads, snapshotReads,
    'Ordered command/live overlap must not add another protected snapshot read');
  const timings = await bot.request('/v1/latency?actorId=900');
  assert.equal(timings.status, 200);
  const pause = timings.body.records.find(record => record.command === 'pause');
  assert.ok(pause?.success);
  assert.equal(pause.playback.count, 1);
  assert.ok(pause.authorization.count >= 2);
  assert.equal(typeof pause.readyForMutationMs, 'number');
  assert.equal((await bot.request('/v1/latency?actorId=200')).status, 403);
});
