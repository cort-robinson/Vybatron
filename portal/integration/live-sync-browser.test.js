// Real compiled browser -> API/auth/SSE -> authoritative bot adapter. Only the
// external Discord and audio boundaries are controlled, including slow policy
// reads and transient Discord failures seen during the owner's listening check.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPortalServer } from '../server/src/app.js';
import { loadConfig } from '../server/src/config.js';
import { portalFixture } from '../../tests/portal-fixtures.js';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const { chromium, expect: browserExpect } = createRequire(path.join(web, 'package.json'))('@playwright/test');
const expect = browserExpect.configure({ timeout: 12_000 });
async function freePort() {
  const server = http.createServer(); server.listen(0, '127.0.0.1');
  await once(server, 'listening'); const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}

test('two real clients recover transient authorization reads and synchronize slow controls without replay', { timeout: 70_000 }, async t => {
  let unavailableUntil = 0; let rejectedPolicyReads = 0;
  const bot = await portalFixture(t, { memberFetch: async () => {
    await delay(150);
    if (Date.now() < unavailableUntil) { rejectedPolicyReads++; throw new Error('Synthetic Discord network outage'); }
  } });
  for (const user of bot.users.values()) user.displayAvatarURL = () => null;
  let channelListReads = 0; let individualChannelReads = 0;
  const channelFetch = bot.guild.channels.fetch.bind(bot.guild.channels);
  bot.guild.channels.fetch = async (id, options) => {
    if (!id) {
      channelListReads++;
      throw new Error('Synthetic exhausted server-wide channel-list bucket');
    }
    individualChannelReads++;
    return channelFetch(id, options);
  };
  const pause = bot.player.pause.bind(bot.player);
  bot.player.pause = async () => { await delay(800); return pause(); };
  let app; let browser; let failFirstSnapshot = true;
  const origin = `http://127.0.0.1:${await freePort()}`;
  const discord = http.createServer(async (req, res) => {
    if (req.url.startsWith('/authorize?')) {
      const authorize = new URL(req.url, 'http://discord.fixture');
      res.writeHead(302, { location: origin + '/auth/discord/callback?code=sync-fixture&state=' + authorize.searchParams.get('state') });
      res.end(); return;
    }
    for await (const _ of req) { /* real OAuth request, synthetic external reply */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/token'
      ? { access_token: 'synthetic-sync-token', token_type: 'Bearer', scope: 'identify' }
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
  const secret = 'independent-sync-browser-session-secret-123456';
  app = await createPortalServer({ ...loadConfig({ NODE_ENV: 'test', PORTAL_ORIGIN: origin,
    PORTAL_BOT_URL: bot.origin, PORTAL_BRIDGE_TOKEN: bot.token, DISCORD_CLIENT_SECRET: secret,
    DISCORD_CLIENT_ID: '123456789012345678', PORTAL_SESSION_SECRET: secret,
    PORTAL_DATA_DIR: path.join(bot.dir, 'sync-auth'), PORTAL_WEB_DIST: path.join(web, 'dist'),
    PORTAL_PORT: String(new URL(origin).port) }), discordAuthorizeUrl: discordOrigin + '/authorize' },
  { discordOrigin, limits: { pollMs: 200 } });
  const requests = [];
  app.server.prependListener('request', (req, res) => {
    const resource = new URL(req.url, origin).pathname;
    requests.push({ method: req.method, resource });
    if (resource === '/api/bootstrap' && failFirstSnapshot) {
      // Bootstrap succeeds; the first protected snapshot/library reads fail.
      // The anonymous startup 401 must not inject a failure into the OAuth
      // callback's separate authority check before a login exists.
      res.once('finish', () => {
        if (res.statusCode === 200 && failFirstSnapshot) {
          failFirstSnapshot = false; unavailableUntil = Date.now() + 700;
        }
      });
    }
  });
  await app.listen();
  const count = (method, resource) => requests.filter(req => req.method === method && req.resource === resource).length;
  browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' });
  const desktop = await browser.newContext({ viewport: { width: 1488, height: 1056 }, reducedMotion: 'reduce' });
  const phone = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const pages = [await desktop.newPage(), await phone.newPage()];
  const errors = [];
  for (const page of pages) {
    page.setDefaultTimeout(12_000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole('link', { name: /Continue with Discord/ }).click();
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  }
  assert.ok(count('GET', '/api/guilds/100') >= 2, 'Both devices must obtain independently authorized state after startup failure');
  const commandPath = '/api/guilds/100/commands';
  const beforePause = count('POST', commandPath);
  await pages[0].getByRole('button', { name: 'Pause playback' }).click();
  await Promise.all(pages.map(page => expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled()));
  assert.equal(bot.player.paused, true);
  assert.equal(count('POST', commandPath), beforePause + 1);
  assert.equal(bot.calls.filter(call => call === 'pause').length, 1, 'SSE overlap must never replay Pause');

  // Both long-lived streams encounter a real private-bridge 503. The compiled
  // clients must retain context read-only and recover without a Refresh click.
  await expect.poll(() => app.resourceCounts().streams).toBe(2);
  // The reconciled command may have opened a stream whose first delayed
  // authorization is still pending. Establish it before injecting the fault.
  await delay(250);
  const streamsBeforeTransient = count('GET', '/api/guilds/100/events');
  unavailableUntil = Date.now() + 1_800;
  await Promise.all(pages.map(page => expect(page.getByRole('button', { name: 'Resume playback' })).toBeDisabled()));
  await Promise.all(pages.map(page => expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled()));
  assert.equal(count('POST', commandPath), beforePause + 1);
  assert.equal(count('GET', '/api/guilds/100/events'), streamsBeforeTransient,
    'An application error on an open stream must respect server backoff, not force new streams');
  await pages[1].getByRole('button', { name: 'Resume playback' }).click();
  await Promise.all(pages.map(page => expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled()));
  assert.equal(bot.player.playing, true);

  // A mobile network outage retains the last display but disables controls.
  // Changes on desktop must arrive fresh when phone connectivity returns.
  const beforeOffline = count('POST', commandPath);
  await phone.setOffline(true);
  await expect(pages[1].getByRole('button', { name: 'Pause playback' })).toBeDisabled();
  await pages[0].getByRole('button', { name: 'Pause playback' }).click();
  await expect(pages[0].getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  await phone.setOffline(false);
  await expect(pages[1].getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  assert.equal(count('POST', commandPath), beforeOffline + 1, 'Restored connectivity must issue reads, never offline writes');

  // Revocation must clear protected state on both devices even though transient
  // failures retain the last known display. This exercises the real policy.
  bot.channels.get('300').hidden.add('200');
  await Promise.all(pages.map(async page => {
    const player = page.getByTestId('player');
    await expect(player.getByRole('button', { name: 'Open player details', exact: true })).toBeVisible();
    await expect(player.getByText('Your next good vibe', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume playback' })).toBeDisabled();
  }));
  assert.ok(rejectedPolicyReads >= 2, 'Real authority failures must actually reach the integration boundary');
  assert.equal(channelListReads, 0, 'Login, live streams, library and controls must not depend on the server-wide channel-list bucket');
  assert.ok(individualChannelReads > 10, 'The real bridge must continuously authorize relevant channels with fresh individual reads');
  assert.deepEqual(errors, []);
  assert.ok(count('GET', '/api/guilds/100/events') < 25, 'Recovery must be bounded rather than a reconnect storm');
});
