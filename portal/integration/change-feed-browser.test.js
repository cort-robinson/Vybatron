// Real compiled browser -> API/auth/SSE -> bot change feed -> authoritative bot
// adapter. Polling is pushed out to a minute, so Discord-side changes can only
// reach the page through the change feed and each stream's own fresh read.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createPortalServer } from '../server/src/app.js';
import { loadConfig } from '../server/src/config.js';
import { portalFixture } from '../../tests/portal-fixtures.js';
import { cssScene } from './css-scene.mjs';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const { chromium, expect: browserExpect } = createRequire(path.join(web, 'package.json'))('@playwright/test');
const expect = browserExpect.configure({ timeout: 5_000 });
async function freePort() {
  const server = http.createServer(); server.listen(0, '127.0.0.1');
  await once(server, 'listening'); const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}

test('Discord-side playback, queue and voice changes reach the browser through the change feed', { timeout: 60_000 }, async t => {
  const bot = await portalFixture(t);
  for (const user of bot.users.values()) user.displayAvatarURL = () => null;
  let app; let browser;
  const origin = `http://127.0.0.1:${await freePort()}`;
  const discord = http.createServer(async (req, res) => {
    if (req.url.startsWith('/authorize?')) {
      const authorize = new URL(req.url, 'http://discord.fixture');
      res.writeHead(302, { location: origin + '/auth/discord/callback?code=feed-fixture&state=' + authorize.searchParams.get('state') });
      res.end(); return;
    }
    for await (const _ of req) { /* real OAuth request, synthetic external reply */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/token'
      ? { access_token: 'synthetic-feed-token', token_type: 'Bearer', scope: 'identify' }
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
  const secret = 'independent-feed-browser-session-secret-12345';
  app = await createPortalServer({ ...loadConfig({ NODE_ENV: 'test', PORTAL_ORIGIN: origin,
    PORTAL_BOT_URL: bot.origin, PORTAL_BRIDGE_TOKEN: bot.token, DISCORD_CLIENT_SECRET: secret,
    DISCORD_CLIENT_ID: '123456789012345678', PORTAL_SESSION_SECRET: secret,
    PORTAL_DATA_DIR: path.join(bot.dir, 'feed-auth'), PORTAL_WEB_DIST: path.join(web, 'dist'),
    PORTAL_PORT: String(new URL(origin).port) }), discordAuthorizeUrl: discordOrigin + '/authorize' },
  { discordOrigin, changeFeed: true, limits: { pollMs: 60_000, pollFeedMs: 60_000 } });
  const posts = [];
  app.server.prependListener('request', req => { if (req.method === 'POST' && req.url.endsWith('/commands')) posts.push(req.url); });
  await app.listen();
  await expect.poll(() => app.resourceCounts().feedLive).toBe(true);
  browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })).newPage(); await page.addInitScript(cssScene);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('link', { name: /Continue with Discord/ }).click();
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  // Home is the landing view; the shared queue lives under Session.
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  const timings = {};
  const measure = async (label, change, observed) => {
    const started = performance.now(); change(); await observed();
    timings[label] = Math.round(performance.now() - started);
  };

  // A /pause slash command or Discord button pauses through Lavalink, not the portal.
  await measure('pause', () => { bot.player.paused = true; bot.player.playing = false; bot.manager.emit('playerPaused', bot.player); },
    () => expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled());
  // A native /move or /shuffle edits the queue without any Lavalink event.
  const rows = page.locator('.queue:not(.queue-compact) .track-row strong');
  await expect(rows).toHaveText(['Song lmnopqrstuv', 'Song 01234567890']);
  await measure('queue', () => { bot.player.queue.tracks.reverse(); },
    () => expect(rows).toHaveText(['Song 01234567890', 'Song lmnopqrstuv']));
  // Leaving voice in Discord removes same-voice control at once.
  const member = bot.members.get('200');
  await measure('voice', () => {
    const before = { channelId: '300', guild: { id: '100' } };
    member.voice.channel = null; bot.client.emit('voiceStateUpdate', before, { channelId: null, guild: { id: '100' } });
  }, () => expect(page.getByRole('button', { name: 'Resume playback' })).toBeDisabled());
  t.diagnostic(`change feed to browser (ms): ${JSON.stringify(timings)}`);
  for (const [label, ms] of Object.entries(timings)) assert.ok(ms < 2_000, `${label} took ${ms} ms with a one-minute poll`);
  assert.deepEqual(posts, [], 'Observing Discord changes never sends a command');
  assert.deepEqual(errors, []);
});
