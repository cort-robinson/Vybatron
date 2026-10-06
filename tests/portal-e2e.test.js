import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPortalServer, SESSION_COOKIE, OAUTH_COOKIE } from '../portal/server/src/app.js';
import { loadConfig } from '../portal/server/src/config.js';
import { portalFixture } from './portal-fixtures.js';
import { trackReference } from '../src/utils/library.js';

const origin = 'https://portal.integration.test';
const secret = 'integration-only-distinct-oauth-session-secret-12345';
const cookieFrom = (response, name) => response.headers.getSetCookie().find(c => c.startsWith(name + '=')).split(';')[0];

async function integrated(t) {
  const bot = await portalFixture(t);
  let actor = '200';
  const discord = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume the real OAuth form body */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/token' ? { access_token: 'test-oauth-only', scope: 'identify', token_type: 'Bearer' } : { id: actor, username: 'listener' }));
  });
  discord.listen(0, '127.0.0.1'); await once(discord, 'listening');
  const webDist = path.join(bot.dir, 'web'); await fs.mkdir(webDist);
  await fs.writeFile(path.join(webDist, 'index.html'), '<!doctype html><title>Integration shell</title>');
  const config = { ...loadConfig({ NODE_ENV: 'test', PORTAL_ORIGIN: origin,
    PORTAL_BOT_URL: bot.origin, PORTAL_BRIDGE_TOKEN: bot.token,
    DISCORD_CLIENT_SECRET: secret, DISCORD_CLIENT_ID: '123456789012345678',
    PORTAL_SESSION_SECRET: secret, PORTAL_DATA_DIR: path.join(bot.dir, 'auth'), PORTAL_WEB_DIST: webDist }), port: 0 };
  const options = { discordOrigin: `http://127.0.0.1:${discord.address().port}`, limits: { pollMs: 30, heartbeatMs: 40 } };
  let app, base;
  async function start() { app = await createPortalServer(config, options); await app.listen(); base = `http://127.0.0.1:${app.server.address().port}`; }
  await start();
  t.after(async () => { await app.close(); discord.closeAllConnections(); await new Promise(resolve => discord.close(resolve)); });
  async function request(route, device, body) {
    const response = await fetch(base + route, { redirect: 'manual',
      ...(body && { method: 'POST', body: JSON.stringify(body) }),
      headers: { ...(device && { Cookie: device.cookie }), ...(body && { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': device.csrf }) } });
    return { status: response.status, body: await response.json() };
  }
  async function login(id = '200') {
    actor = id;
    const begin = await fetch(base + '/auth/discord', { redirect: 'manual' });
    assert.equal(begin.status, 302);
    const state = new URL(begin.headers.get('location')).searchParams.get('state');
    const callback = await fetch(base + '/auth/discord/callback?code=verified-test-code&state=' + state,
      { redirect: 'manual', headers: { Cookie: cookieFrom(begin, OAUTH_COOKIE) } });
    assert.equal(callback.status, 302);
    const device = { cookie: cookieFrom(callback, SESSION_COOKIE) };
    const boot = await request('/api/bootstrap', device); assert.equal(boot.status, 200);
    return { ...device, csrf: boot.body.csrfToken, bootstrap: boot.body };
  }
  return { bot, login, request, command: (device, body) => request('/api/guilds/100/commands', device, body),
    snapshot: device => request('/api/guilds/100', device), get base() { return base; },
    restart: async () => { await app.close(); await start(); } };
}

test('real OAuth/API/bridge command path preserves capabilities, CSRF, identity and actual pause/seek/resume', { timeout: 10_000 }, async t => {
  const f = await integrated(t); const device = await f.login();
  assert.equal(device.bootstrap.viewer.id, '200');
  assert.equal(device.bootstrap.viewer.maintainer, false);
  assert.ok(device.bootstrap.filters.some(filter => filter.id === 'warm'));
  assert.equal((await f.request('/api/guilds/100/diagnostics', device)).status, 403);
  assert.equal((await f.command(device, { command: 'stop', actorId: '900' })).status, 400);
  assert.equal((await f.command({ ...device, csrf: 'invalid' }, { command: 'stop' })).status, 403);
  assert.equal(f.bot.calls.length, 0);
  const paused = await f.command(device, { command: 'pause' });
  assert.equal(paused.status, 200); assert.equal(f.bot.player.paused, true);
  const seek = await f.command(device, { command: 'seek', options: { timestamp: '1:47' }, expectedRevision: paused.body.snapshot.revision });
  assert.equal(seek.status, 200); assert.equal(f.bot.player.position, 107_000);
  const resumed = await f.command(device, { command: 'resume' });
  assert.equal(resumed.status, 200); assert.equal(f.bot.player.playing, true);
  assert.doesNotMatch(JSON.stringify(resumed.body), /encoded-|test-oauth-only|integration-only|Bearer/);
});

test('joined API/bridge rejects a stale Discord queue edit and exposes only the refreshed authoritative state', { timeout: 10_000 }, async t => {
  const f = await integrated(t); const device = await f.login();
  const before = await f.snapshot(device);
  const native = await f.bot.command({ command: 'remove', options: { position: 1 }, expectedRevision: before.body.revision });
  assert.equal(native.status, 200);
  const stale = await f.command(device, { command: 'remove', options: { position: 1 }, expectedRevision: before.body.revision });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  const vanished = await f.command(device, { command: 'move', options: { from: 1, to: 2 }, expectedRevision: before.body.revision });
  assert.equal(vanished.status, 409, 'A vanished old queue position must refresh intent rather than report invalid input');
  const fresh = await f.snapshot(device);
  assert.notEqual(fresh.body.revision, before.body.revision);
  assert.equal(fresh.body.session.queue.length, 1);
  assert.equal(f.bot.calls.filter(call => call === 'splice').length, 1);
});

test('global private favorites survive auth restart, allow visible source saves outside voice, and never leak to another account', { timeout: 10_000 }, async t => {
  const f = await integrated(t); const device = await f.login();
  f.bot.members.get('200').voice.channel = null;
  const state = await f.snapshot(device); assert.equal(state.body.session.canControl, false);
  const save = await f.command(device, { command: 'favorite', subcommand: 'add', expectedRevision: state.body.revision });
  assert.equal(save.status, 200);
  const mine = await f.request('/api/guilds/100/library', device);
  assert.equal(mine.body.favorites.length, 1);
  const other = await f.login('201');
  assert.equal((await f.request('/api/guilds/100/library', other)).body.favorites.length, 0);
  await f.restart();
  assert.equal((await f.request('/api/guilds/100/library', device)).body.favorites.length, 1);
  f.bot.channels.get('300').hidden.add('200');
  const hidden = await f.snapshot(device); assert.equal(hidden.body.session.current, null);
  const denied = await f.command(device, { command: 'favorite', subcommand: 'add', expectedRevision: hidden.body.revision });
  assert.equal(denied.status, 403);
});

test('real SSE synchronization stops on fresh Discord membership loss while Discord playback continues', { timeout: 10_000 }, async t => {
  const f = await integrated(t); const device = await f.login();
  const controller = new AbortController();
  const stream = await fetch(f.base + '/api/guilds/100/events', { headers: { Cookie: device.cookie }, signal: controller.signal });
  assert.equal(stream.status, 200); const reader = stream.body.getReader();
  t.after(() => controller.abort());
  const first = await reader.read(); assert.match(Buffer.from(first.value).toString(), /event:snapshot/);
  f.bot.members.delete('200');
  const deadline = Date.now() + 1500; let ended = false;
  while (Date.now() < deadline) { const frame = await reader.read(); if (frame.done) { ended = true; break; } await delay(5); }
  assert.equal(ended, true); assert.equal(f.bot.player.playing, true);
  assert.equal((await f.snapshot(device)).status, 404);
});

test('real authenticated API and bot writer reject retargeted favorites, hidden replay and replaced mix confirmations', { timeout: 15_000 }, async t => {
  const f = await integrated(t); const first = await f.login(); const second = await f.login();
  const refs = [f.bot.player.queue.current, ...f.bot.player.queue.tracks].map(trackReference);
  await f.bot.library.updateFavorites('200', list => list.push(...refs));
  const displayed = (await f.request('/api/guilds/100/library', first)).body;
  const removal = await f.command(second, { command: 'favorite', subcommand: 'remove', options: { index: 1 }, expectedTrackId: displayed.favorites[0].id });
  assert.equal(removal.status, 200);
  for (const action of ['remove', 'play']) {
    const stale = await f.command(first, { command: 'favorite', subcommand: action, options: { index: 2 }, expectedTrackId: displayed.favorites[1].id });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
  }
  assert.deepEqual(f.bot.library.favorites('200').map(track => track.uri), refs.slice(1).map(track => track.uri));
  assert.equal(f.bot.calls.filter(call => call === 'add').length, 0);

  await f.bot.library.updateGuild('100', guild => {
    guild.history = [
      { id: 'history-selected-a', playedAt: Date.now(), voiceChannelId: '301', track: refs[0] },
      { id: 'history-selected-b', playedAt: Date.now(), voiceChannelId: '300', track: refs[1] },
    ];
    guild.mixes.night = { ownerId: '200', tracks: refs, savedAt: Date.now() };
  });
  const library = (await f.request('/api/guilds/100/library', first)).body;
  const state = (await f.snapshot(first)).body;
  f.bot.channels.get('301').hidden.add('200');
  const replay = await f.command(first, { command: 'replay', options: { index: 1 }, expectedRevision: state.revision, expectedHistoryId: library.history[0].id });
  assert.equal(replay.status, 409, JSON.stringify(replay.body));
  assert.equal(f.bot.calls.filter(call => call === 'add').length, 0);

  const version = library.mixes[0].version;
  assert.match(version, /^[a-f0-9]{32}$/);
  await f.bot.library.updateGuild('100', guild => { guild.mixes.night = { ...guild.mixes.night, tracks: [...refs, refs[0]], savedAt: Date.now() + 1 }; });
  const deleted = await f.command(first, { command: 'mix', subcommand: 'delete', options: { name: 'night' }, expectedMixVersion: version });
  assert.equal(deleted.status, 409, JSON.stringify(deleted.body));
  assert.equal(f.bot.library.readGuild('100').mixes.night.tracks.length, 4);
  const fresh = (await f.request('/api/guilds/100/library', first)).body;
  assert.notEqual(fresh.mixes[0].version, version);
  const accepted = await f.command(first, { command: 'mix', subcommand: 'delete', options: { name: 'night' }, expectedMixVersion: fresh.mixes[0].version });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(f.bot.library.readGuild('100').mixes.night, undefined);
});
