// Actual compiled browser, OAuth, API, SSE and authoritative adapter. Only the
// external Discord/audio boundaries are controlled. An independent authorized
// read may observe playback while command disclosure still awaits fresh input.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPortalServer } from '../server/src/app.js';
import { loadConfig } from '../server/src/config.js';
import { deferred, portalFixture } from '../../tests/portal-fixtures.js';
import { cssScene } from './css-scene.mjs';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const { chromium, expect } = createRequire(path.join(web, 'package.json'))('@playwright/test');
async function freePort() {
  const server = http.createServer(); server.listen(0, '127.0.0.1');
  await once(server, 'listening'); const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}

test('the acting device shows its change at once and queues further taps behind a held confirmation', { timeout: 40_000 }, async t => {
  const bot = await portalFixture(t);
  for (const user of bot.users.values()) user.displayAvatarURL = () => null;
  const disclosureEntered = deferred(), releaseDisclosure = deferred();
  let armed = false, held = false, disclosureReleased = false, commandReplies = 0;
  let streamMemberReadsDuringDisclosure = 0;
  const fetchMember = bot.guild.members.fetch.bind(bot.guild.members);
  bot.guild.members.fetch = async (...args) => {
    // Native authority has finished before Pause arms the disclosure gate.
    // Final disclosure cannot reach member reads while its identity is held.
    // Count real stream reads in that interval, allowing overlapping devices
    // to share pending work without assuming separate underlying REST calls.
    if (held && !disclosureReleased) streamMemberReadsDuringDisclosure++;
    return fetchMember(...args);
  };
  const fetchUser = bot.client.users.fetch.bind(bot.client.users);
  bot.client.users.fetch = async (...args) => {
    // Armed inside the real native Pause. The command's next fresh identity
    // read is its final disclosure stage; subsequent stream reads are unheld.
    if (armed && !held && args[0] === '200') {
      held = true; disclosureEntered.resolve(); await releaseDisclosure.promise;
    }
    return fetchUser(...args);
  };
  const pause = bot.player.pause.bind(bot.player);
  bot.player.pause = async () => { await pause(); armed = true; };
  const origin = `http://127.0.0.1:${await freePort()}`;
  let app, browser;
  const discord = http.createServer(async (req, res) => {
    if (req.url.startsWith('/authorize?')) {
      const state = new URL(req.url, 'http://discord.fixture').searchParams.get('state');
      res.writeHead(302, { location: origin + '/auth/discord/callback?code=completion-fixture&state=' + state });
      res.end(); return;
    }
    for await (const _ of req) { /* controlled external OAuth response */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/token'
      ? { access_token: 'synthetic-completion-token', token_type: 'Bearer', scope: 'identify' }
      : { id: '200', username: 'listener' }));
  });
  t.after(async () => {
    releaseDisclosure.resolve();
    try { await browser?.close(); } finally {
      try { await app?.close(); } finally {
        discord.closeAllConnections(); if (discord.listening) await new Promise(resolve => discord.close(resolve));
      }
    }
  });
  discord.listen(0, '127.0.0.1'); await once(discord, 'listening');
  const discordOrigin = `http://127.0.0.1:${discord.address().port}`;
  const secret = 'synthetic-completion-session-secret-12345678';
  app = await createPortalServer({ ...loadConfig({ NODE_ENV: 'test', PORTAL_ORIGIN: origin,
    PORTAL_BOT_URL: bot.origin, PORTAL_BRIDGE_TOKEN: bot.token, DISCORD_CLIENT_SECRET: secret,
    DISCORD_CLIENT_ID: '123456789012345678', PORTAL_SESSION_SECRET: secret,
    PORTAL_DATA_DIR: path.join(bot.dir, 'completion-auth'), PORTAL_WEB_DIST: path.join(web, 'dist'),
    PORTAL_PORT: String(new URL(origin).port) }), discordAuthorizeUrl: discordOrigin + '/authorize' },
  { discordOrigin, limits: { pollMs: 400 } });
  const commands = [];
  app.server.prependListener('request', (req, res) => {
    if (req.method === 'POST' && new URL(req.url, origin).pathname === '/api/guilds/100/commands') {
      commands.push(req.method);
      res.once('finish', () => { commandReplies++; });
    }
  });
  await app.listen();
  browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' });
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1488, height: 1056 }, reducedMotion: 'reduce' }),
    browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' }),
  ]);
  await Promise.all(contexts.map(context => context.addInitScript(cssScene)));
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  for (const page of pages) {
    await page.goto(origin);
    await page.getByRole('link', { name: /Continue with Discord/ }).click();
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  }
  // Each page holds its server stream and its listener stream (/api/me/events).
  await expect.poll(() => app.resourceCounts().streams).toBe(4);
  await pages[0].getByRole('button', { name: 'Pause playback' }).click();
  await disclosureEntered.promise;
  assert.equal(bot.player.paused, true);
  assert.equal(bot.calls.filter(call => call === 'pause').length, 1);
  const resume = pages[0].getByRole('button', { name: 'Resume playback' });
  // The acting device shows its change at once and stays usable while the
  // final disclosure is held; it never waits behind a confirmation lock.
  await expect(resume).toBeEnabled();
  await expect(resume.locator('.spinner')).toHaveCount(0);
  await expect(pages[0].getByText(/Waiting for confirmation/i)).toHaveCount(0);
  await expect(pages[0].locator('.transport')).not.toHaveAttribute('aria-busy', 'true');
  await expect(pages[1].getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  await expect.poll(() => streamMemberReadsDuringDisclosure).toBeGreaterThan(0);
  assert.equal(commandReplies, 0, 'Fresh stream observation does not complete final command disclosure');
  // A second tap is queued behind the unconfirmed Pause, not sent alongside it.
  await resume.click();
  await expect(pages[0].getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  assert.equal(commands.length, 1, 'One command reaches the bot at a time');
  assert.equal(bot.calls.filter(call => call === 'resume').length, 0);
  disclosureReleased = true; releaseDisclosure.resolve();
  await expect.poll(() => commandReplies).toBe(2);
  await Promise.all(pages.map(page => expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled()));
  assert.equal(commands.length, 2);
  assert.equal(bot.calls.filter(call => call === 'pause').length, 1);
  assert.equal(bot.calls.filter(call => call === 'resume').length, 1, 'The queued Resume is sent once, after Pause confirms');
  const timings = await bot.request('/v1/latency?actorId=900');
  assert.equal(timings.status, 200);
  const record = timings.body.records.find(item => item.command === 'pause');
  assert.ok(record?.success);
  assert.equal(record.playback.count, 1);
  assert.ok(record.authorization.count >= 2);
  assert.equal(record.authority.native.count, 1);
  assert.equal(record.authority.finalDisclosure.count, 1);
  assert.equal(record.authority.finalDisclosure.inputs.user.count, 1);
  t.diagnostic('Controlled final identity read held; independently authorized streams observed Pause before the reply. This is protocol evidence, not deployed latency.');
});
