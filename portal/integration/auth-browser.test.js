// Real browser -> Vite proxy -> OAuth/API -> authoritative bot adapter.
// Only the external Discord/Lavalink network boundaries are deterministic fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPortalServer } from '../server/src/app.js';
import { loadConfig } from '../server/src/config.js';
import { portalFixture } from '../../tests/portal-fixtures.js';
import { cssScene } from './css-scene.mjs';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const { chromium } = createRequire(path.join(web, 'package.json'))('@playwright/test');
async function freePort() { const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(r => server.close(r)); return port; }

test('browser OAuth secure cookies, exact origin, live controls and bodyless logout work through the real Vite proxy', { timeout: 40_000 }, async t => {
  const bot = await portalFixture(t);
  const discord = http.createServer(async (req, res) => {
    if (req.url.startsWith('/authorize?')) {
      const authorize = new URL(req.url, 'http://mock-discord.test');
      assert.equal(authorize.searchParams.get('redirect_uri'), origin + '/auth/discord/callback');
      res.writeHead(302, { location: origin + '/auth/discord/callback?code=browser-test-code&state=' + authorize.searchParams.get('state') }); res.end(); return;
    }
    for await (const _ of req) { /* consume real confidential OAuth form */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/token' ? { access_token: 'browser-test-oauth', token_type: 'Bearer', scope: 'identify' } : { id: '200', username: 'listener' }));
  });
  discord.listen(0, '127.0.0.1'); await once(discord, 'listening');
  const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
  const secret = 'independent-browser-test-session-key-123456789';
  const app = await createPortalServer({ ...loadConfig({ NODE_ENV: 'test', PORTAL_ORIGIN: origin,
    PORTAL_BOT_URL: bot.origin, PORTAL_BRIDGE_TOKEN: bot.token, DISCORD_CLIENT_SECRET: secret,
    DISCORD_CLIENT_ID: '123456789012345678', PORTAL_SESSION_SECRET: secret,
    PORTAL_DATA_DIR: path.join(bot.dir, 'auth'), PORTAL_WEB_DIST: path.join(web, 'dist') }), port: 0,
    discordAuthorizeUrl: `http://127.0.0.1:${discord.address().port}/authorize` },
    { discordOrigin: `http://127.0.0.1:${discord.address().port}`, limits: { pollMs: 100 } });
  await app.listen();
  const vite = spawn(process.execPath, [path.join(web, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: web, env: { ...process.env, VITE_API_PROXY: `http://127.0.0.1:${app.server.address().port}` }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = ''; vite.stdout.on('data', c => { logs += c.toString(); }); vite.stderr.on('data', c => { logs += c.toString(); });
  let browser;
  t.after(async () => {
    await browser?.close(); vite.kill(); await app.close(); discord.closeAllConnections();
    await new Promise(r => discord.close(r));
  });
  browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' }); const page = await browser.newPage(); await page.addInitScript(cssScene);
  page.setDefaultTimeout(8_000);
  const responses = [];
  page.on('response', r => { const url = new URL(r.url()); if (url.origin === origin && /^(\/api|\/auth)/.test(url.pathname)) responses.push({ path: url.pathname, status: r.status() }); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (vite.exitCode !== null) assert.fail('Vite could not start: ' + logs);
    if (await fetch(origin).then(r => r.ok).catch(() => false)) break;
    await new Promise(r => setTimeout(r, 50));
  }
  await page.goto(origin);
  await page.getByRole('link', { name: /Continue with Discord/ }).click();
  await page.getByRole('button', { name: 'Pause playback' }).waitFor().catch(async () => {
    assert.fail(JSON.stringify({ responses, page: await page.locator('body').innerText(), cookies: (await page.context().cookies()).map(c => ({ name: c.name, secure: c.secure, httpOnly: c.httpOnly })) }));
  });
  const cookies = await page.context().cookies(); const session = cookies.find(c => c.name === '__Host-vybertron_session');
  assert.ok(session, 'Actual browser must accept Secure __Host OAuth/session cookies through loopback proxy');
  assert.equal(session.secure, true); assert.equal(session.httpOnly, true); assert.equal(session.path, '/');
  assert.equal(await page.evaluate(() => document.cookie.includes('vybertron_session')), false);
  await page.getByRole('button', { name: 'Pause playback' }).click();
  await page.getByRole('button', { name: 'Resume playback' }).waitFor(); assert.equal(bot.player.paused, true);
  await page.getByRole('button', { name: 'Resume playback' }).click();
  await page.getByRole('button', { name: 'Pause playback' }).waitFor(); assert.equal(bot.player.playing, true);
  await page.getByRole('button', { name: 'Account options' }).click();
  await page.getByRole('button', { name: 'Sign out on this device' }).click();
  await page.getByRole('link', { name: /Continue with Discord/ }).waitFor();
  const signedOut = await page.evaluate(() => fetch('/api/bootstrap').then(r => r.status));
  assert.equal(signedOut, 401); assert.equal(bot.player.playing, true);
});
