import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { createPortalServer, SESSION_COOKIE, OAUTH_COOKIE } from '../src/app.js';
import { loadConfig, LIMITS } from '../src/config.js';
import { Transport } from '../src/transport.js';
import { eventStream } from '../src/compression.js';
import { Writable } from 'node:stream';
import { parseUpstreamTiming } from '../src/timing.js';

const actorId = '123456789012345678'; const guildId = '234567890123456789';
const secret = 'test-only-32-character-secret-abcdef0123456789';
const origin = 'https://portal.example.test';
const snapshot = () => ({
  guild: { id: guildId, name: 'Private guild', iconUrl: null, admin: true }, revision: 'revision-1',
  session: { status: 'idle', voiceChannel: null, textChannel: null, current: null, queue: [], positionMs: 0, durationMs: 0,
    volume: 100, filter: 'off', repeat: 'off', radio: false, fairQueue: false, listeners: [], canAdd: true, canControl: true, canVote: true, reason: null },
  savedSession: { exists: false, savedAt: null, positionMs: 0, paused: false, trackCount: 0, voiceChannel: null, canResume: false },
  settings: { volume: 100, fairQueue: false, djRoleId: null, musicTextChannelId: null }, channels: [], roles: [],
});
const bootstrap = () => ({ viewer: { id: actorId, username: 'listener', displayName: 'Listener', avatarUrl: null, maintainer: false },
  guilds: [snapshot().guild], filters: [{ id: 'off', label: 'Off', description: 'No filter' }], commands: [] });

function reply(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }); res.end(body);
}

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

// One socket per request left ~750 TIME_WAIT ports per run; parallel runs exhausted the
// Windows ephemeral port range. Reuse connections instead.
const keepAlive = new http.Agent({ keepAlive: true });
test.after(() => keepAlive.destroy());

async function request(base, pathname, { method = 'GET', headers = {}, body } = {}) {
  return await new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = http.request({ hostname: url.hostname, port: url.port, path: pathname, method, headers,
      agent: keepAlive, timeout: 2000 }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks); const text = body.toString();
        resolve({ status: res.statusCode, headers: res.headers, body, text, json: () => JSON.parse(text) });
      });
      res.on('error', reject);
    });
    req.once('timeout', () => req.destroy(new Error(`Test HTTP deadline (${method} ${pathname})`))); req.on('error', reject); req.end(body);
  });
}

const cookieValue = (response, name) => response.headers['set-cookie'].find(value => value.startsWith(`${name}=`)).split(';')[0];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) assert.fail('Bounded test condition did not complete'); await delay(10); }
}

async function fixture(t, { limits = {}, now, dataDir, production = false, botOrigin, botToken, changeFeed = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vybertron-portal-test-'));
  const webDist = path.join(directory, 'web'); await fs.mkdir(webDist);
  await fs.writeFile(path.join(webDist, 'index.html'), '<!doctype html><html>Portal shell</html>');
  await fs.writeFile(path.join(webDist, 'app-abcdefgh.js'), 'window.portal = true;');
  await fs.writeFile(path.join(webDist, 'sw.js'), '// Static shell only; never caches private API');
  await fs.writeFile(path.join(directory, 'outside.txt'), 'never public');
  const state = { authorized: true, discordStatus: 200, identity: actorId, calls: [], tokenCalls: [],
    snapshot: snapshot(), delayMs: 0, status: null, raw: null, disconnected: 0 };
  const discord = http.createServer(async (req, res) => {
    if (req.url === '/token') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      state.tokenCalls.push(new URLSearchParams(Buffer.concat(chunks).toString()));
      reply(res, state.discordStatus, { access_token: 'private-oauth-token', refresh_token: 'private-refresh-token', token_type: 'Bearer', scope: 'identify' });
    } else {
      assert.equal(req.headers.authorization, 'Bearer private-oauth-token');
      reply(res, state.discordStatus, { id: state.identity, username: 'listener' });
    }
  });
  const discordOrigin = await listen(discord);
  const bridge = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://bridge.local');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const call = { path: url.pathname, params: url.searchParams, body, authorization: req.headers.authorization, range: req.headers.range };
    state.calls.push(call);
    res.once('close', () => { if (!res.writableEnded) state.disconnected++; });
    // The change feed is a held long poll; tests answer it explicitly.
    if (url.pathname === '/v1/changes') { state.feedCalls = (state.feedCalls || 0) + 1; if (state.changes) state.changes(res, call); else reply(res, 404, { error: { code: 'not_found' } }); return; }
    if (state.beforeReply) await state.beforeReply(call);
    if (state.serverTiming !== undefined) res.setHeader('Server-Timing', state.serverTiming);
    if (state.delayMs) await delay(state.delayMs);
    if (res.destroyed) return;
    if (state.bridgeResponse) { state.bridgeResponse(res, call); return; }
    if (state.raw !== null) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(state.raw); return; }
    if (!state.authorized || state.status) { reply(res, state.status || 403, { error: { code: 'private_failure', message: 'SECRET upstream stack / sensitive path' } }); return; }
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    if (url.pathname === '/health') reply(res, 200, { ready: true });
    else if (url.pathname === '/v1/bootstrap') {
      const data = bootstrap(); data.viewer.id = url.searchParams.get('actorId'); data.voiceGuildId = state.voiceGuildId ?? null; if (state.inviteUrl !== undefined) data.inviteUrl = state.inviteUrl; reply(res, 200, data);
    }
    else if (url.pathname.endsWith('/commands')) reply(res, 200, { ok: true, message: 'Updated.', snapshot: state.snapshot, ...state.commandExtra });
    else if (url.pathname.endsWith('/configuration')) reply(res, 200, { guildId, channels: [{ id: '456789012345678901', name: 'Music', type: 'text' }], roles: [] });
    else if (url.pathname.endsWith('/library')) reply(res, 200, { favorites: [], mixes: [], history: [] });
    else if (url.pathname.endsWith('/search')) reply(res, 200, { tracks: [], notice: null });
    else if (url.pathname.endsWith('/diagnostics')) reply(res, 200, { botReady: true, audioReady: true, uptimeSeconds: 10, recoveryState: 'ready', lastError: null });
    else if (url.pathname.endsWith('/activity')) reply(res, 200, { items: [] });
    else if (url.pathname.endsWith('/stats')) reply(res, 200, { serverFavorites: { onRepeat: [], forgottenGems: [] }, personal: { window: url.searchParams.get('window') || '30d', topTracks: [], topArtists: [], rediscover: [] } });
    else if (url.pathname.endsWith('/recap')) reply(res, 200, { window: url.searchParams.get('window') || '30d', since: 0, personal: { plays: 0, playedMs: 0, songs: 0, topTracks: [], topArtists: [] }, server: { plays: 0, playedMs: 0, songs: 0, topTracks: [] } });
    else if (url.pathname === '/v1/stats/requests/clear') reply(res, 200, { ok: true, cleared: 2 });
    else if (/\/lyrics\/[\w-]{11}$/.test(url.pathname)) reply(res, 200, { trackId: 'b'.repeat(24), status: 'not_found', lyrics: null });
    else if (url.pathname.endsWith('/lyrics')) reply(res, 200, { trackId: 'a'.repeat(24), status: 'found', lyrics: { source: 'lrclib', provider: 'LRCLIB', synced: true, lines: [{ startMs: 0, text: 'First line' }] } });
    else reply(res, 200, state.snapshot);
  });
  const botUrl = await listen(bridge);
  const config = { ...loadConfig({ NODE_ENV: production ? 'production' : 'test', PORTAL_ORIGIN: origin,
    PORTAL_BOT_URL: botOrigin || botUrl, PORTAL_BRIDGE_TOKEN: botToken || secret, DISCORD_CLIENT_SECRET: secret,
    DISCORD_CLIENT_ID: '345678901234567890', PORTAL_SESSION_SECRET: secret,
    PORTAL_DATA_DIR: dataDir || path.join(directory, 'data'), PORTAL_WEB_DIST: webDist }), port: 0 };
  let app = await createPortalServer(config, { discordOrigin, limits: { pollMs: 25, heartbeatMs: 35, ...limits }, ...(now && { now }), ...(changeFeed && { changeFeed }) });
  await app.listen(); let base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    discord.closeAllConnections(); bridge.closeAllConnections();
    await Promise.all([new Promise(resolve => discord.close(resolve)), new Promise(resolve => bridge.close(resolve))]);
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function begin() {
    const response = await request(base, '/auth/discord'); assert.equal(response.status, 302);
    return { cookie: cookieValue(response, OAUTH_COOKIE), state: new URL(response.headers.location).searchParams.get('state'), response };
  }
  async function login(existingCookie = '') {
    const pending = await begin();
    const response = await request(base, `/auth/discord/callback?code=valid-code&state=${pending.state}`, {
      headers: { Cookie: [pending.cookie, existingCookie].filter(Boolean).join('; ') },
    });
    assert.equal(response.status, 302, response.text);
    const sessionCookie = cookieValue(response, SESSION_COOKIE);
    const initial = await request(base, '/api/bootstrap', { headers: { Cookie: sessionCookie } }); assert.equal(initial.status, 200);
    return { cookie: sessionCookie, csrf: initial.json().csrfToken, response, pending };
  }
  async function restart() {
    await app.close(); app = await createPortalServer(config, { discordOrigin, limits: { pollMs: 25, heartbeatMs: 35, ...limits }, ...(now && { now }), ...(changeFeed && { changeFeed }) });
    await app.listen(); base = `http://127.0.0.1:${app.server.address().port}`;
  }
  return { state, config, begin, login, restart, request: (...args) => request(base, ...args), get base() { return base; }, get app() { return app; } };
}

async function stream(base, sessionCookie, extra = {}, streamGuildId = guildId, query = '') {
  return await new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/guilds/${streamGuildId}/events${query}`, { headers: { Cookie: sessionCookie, ...extra }, agent: false }, res => {
      const handle = { req, res, text: '', ended: false, close: () => { res.destroy(); req.destroy(); } };
      res.setEncoding('utf8'); res.on('data', data => { handle.text += data; });
      res.on('end', () => { handle.ended = true; }); res.on('close', () => { handle.ended = true; });
      res.on('error', () => {}); resolve(handle);
    });
    req.once('error', reject);
  });
}

function partialCommand(f, device, body = { command: 'stop' }) {
  const payload = JSON.stringify(body); const url = new URL(f.base);
  let req;
  const completed = new Promise((resolve, reject) => {
    req = http.request({ hostname: url.hostname, port: url.port, path: `/api/guilds/${guildId}/commands`, method: 'POST', agent: false,
      headers: { Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode)); res.on('error', reject);
    });
    req.on('error', reject); req.write(payload.slice(0, 1));
  });
  return { req, completed, finish: () => req.end(payload.slice(1)) };
}

const sendCommand = (f, device, command = { command: 'pause' }) => f.request(`/api/guilds/${guildId}/commands`, {
  method: 'POST', headers: { Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf,
    'Content-Type': 'application/json' }, body: JSON.stringify(command),
});
const streamSnapshots = live => [...live.text.matchAll(/event:snapshot\ndata:(.*)\n\n/g)].map(match => JSON.parse(match[1]));

test('Command wake updates a second device promptly with fresh per-actor reads and isolates other guilds', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { pollMs: 10_000 } }); const acting = await f.login();
  const otherActor = '456789012345678901'; const otherGuild = '567890123456789012';
  f.state.identity = otherActor; const viewing = await f.login();
  let revision = 'before-command';
  f.state.bridgeResponse = (res, call) => {
    const data = snapshot(); data.guild.id = call.path.split('/')[3]; data.revision = revision;
    const actor = call.body?.actorId || call.params.get('actorId');
    data.guild.admin = actor === actorId; data.session.canControl = actor === actorId;
    data.settings = actor === actorId ? data.settings : null;
    if (call.body) { revision = 'after-command'; data.revision = 'command-actor-only'; reply(res, 200, { ok: true, message: 'Updated.', snapshot: data }); }
    else reply(res, 200, data);
  };
  const a = await stream(f.base, acting.cookie); const b = await stream(f.base, viewing.cookie);
  const unrelated = await stream(f.base, viewing.cookie, {}, otherGuild);
  for (const live of [a, b, unrelated]) t.after(live.close);
  await until(() => [a, b, unrelated].every(live => streamSnapshots(live).length === 1));
  const before = f.state.calls.length; const began = Date.now();
  assert.equal((await sendCommand(f, acting)).status, 200);
  await until(() => [a, b].every(live => streamSnapshots(live).at(-1).revision === 'after-command'), 1000);
  assert.ok(Date.now() - began < 1000, 'Update must not wait for the 10-second poll timer');
  const reads = f.state.calls.slice(before).filter(call => !call.body);
  assert.deepEqual(reads.map(call => call.params.get('actorId')).sort(), [actorId, otherActor].sort());
  assert.ok(reads.every(call => call.path === `/v1/guilds/${guildId}`));
  assert.equal(streamSnapshots(b).at(-1).guild.admin, false);
  assert.equal(streamSnapshots(b).at(-1).session.canControl, false);
  assert.equal(streamSnapshots(b).at(-1).settings, null);
  assert.ok([a, b].every(live => !live.text.includes('command-actor-only')));
  await delay(100); assert.equal(streamSnapshots(unrelated).length, 1);
  assert.equal(f.state.calls.slice(before).filter(call => call.body).length, 1);
});

function feedResponder(f) {
  const held = []; let sequence = 0;
  f.state.changes = (res, call) => {
    if (call.params.get('instance') !== 'bot-instance') { reply(res, 200, { instanceId: 'bot-instance', sequence, reset: true, guildIds: [] }); return; }
    held.push(res);
  };
  return {
    held: () => held.length,
    publish(guildIds) { sequence++; for (const res of held.splice(0)) reply(res, 200, { instanceId: 'bot-instance', sequence, reset: false, guildIds }); },
    fail() { for (const res of held.splice(0)) reply(res, 503, { error: { code: 'unavailable' } }); f.state.changes = null; },
  };
}

test('The bot change feed wakes only same-guild streams and relaxes the safety poll while healthy', { timeout: 5000 }, async t => {
  const f = await fixture(t, { changeFeed: true, limits: { pollMs: 40, pollFeedMs: 60_000 } });
  const feed = feedResponder(f); const device = await f.login();
  const otherGuild = '567890123456789012';
  await until(() => feed.held() === 1 && f.app.resourceCounts().feedLive);
  let revision = 'before'; f.state.bridgeResponse = (res, call) => { const data = snapshot(); data.guild.id = call.path.split('/')[3]; data.revision = revision; reply(res, 200, data); };
  const live = await stream(f.base, device.cookie); const unrelated = await stream(f.base, device.cookie, {}, otherGuild);
  for (const handle of [live, unrelated]) t.after(handle.close);
  await until(() => streamSnapshots(live).length === 1 && streamSnapshots(unrelated).length === 1);
  await delay(200);
  assert.equal(streamSnapshots(live).length, 1, 'no 40 ms fallback polling while the feed is healthy');
  revision = 'after'; const began = Date.now(); feed.publish([guildId]);
  await until(() => streamSnapshots(live).at(-1).revision === 'after', 1000);
  assert.ok(Date.now() - began < 1000);
  await delay(100); assert.equal(streamSnapshots(unrelated).length, 1, 'other guild streams are not woken');
  assert.ok(f.state.calls.every(call => !call.body), 'the feed never triggers a command');
});

test('Feed loss returns open streams to the fallback poll without replaying anything', { timeout: 5000 }, async t => {
  const f = await fixture(t, { changeFeed: true, limits: { pollMs: 40, pollFeedMs: 60_000 } });
  const feed = feedResponder(f); const device = await f.login();
  await until(() => feed.held() === 1);
  const live = await stream(f.base, device.cookie); t.after(live.close);
  await until(() => streamSnapshots(live).length === 1);
  feed.fail();
  await until(() => !f.app.resourceCounts().feedLive && streamSnapshots(live).length >= 3, 2000);
  assert.ok(f.state.calls.every(call => !call.body));
});

test('Command wakes coalesce during an in-flight stale read and serialize a required fresh follow-up', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { pollMs: 10_000 } }); const device = await f.login();
  const live = await stream(f.base, device.cookie); t.after(live.close);
  await until(() => streamSnapshots(live).length === 1);
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(release);
  let revision = 0; let reads = 0; let activeReads = 0; let maxReads = 0;
  f.state.beforeReply = async call => {
    if (call.body) { revision++; return; }
    call.revision = revision; reads++; activeReads++; maxReads = Math.max(maxReads, activeReads);
    if (reads === 1) await held;
    activeReads--;
  };
  f.state.bridgeResponse = (res, call) => {
    const data = snapshot(); data.revision = `read-${call.revision ?? revision}`;
    reply(res, 200, call.body ? { ok: true, message: 'Updated.', snapshot: data } : data);
  };
  assert.equal((await sendCommand(f, device)).status, 200);
  await until(() => reads === 1);
  const results = await Promise.all(Array.from({ length: 5 }, () => sendCommand(f, device)));
  assert.ok(results.every(result => result.status === 200));
  await delay(100); assert.equal(reads, 1, 'Commands must not start parallel reads');
  assert.equal(streamSnapshots(live).length, 1, 'Command responses must not be used as SSE snapshots');
  release(); await until(() => live.text.includes('read-6'));
  assert.deepEqual(streamSnapshots(live).slice(1).map(data => data.revision), ['read-1', 'read-6']);
  await delay(100); assert.equal(reads, 2, 'Five in-flight notifications need only one follow-up');
  assert.equal(maxReads, 1); assert.equal(revision, 6, 'Each authorized command executes once');
});

test('Commands during initial SSE authorization preserve the wake and fence older shared reads', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { pollMs: 10_000 } });
  const first = await f.login(); const second = await f.login();
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(release);
  let reads = 0; let changed = false;
  f.state.beforeReply = async call => {
    if (call.body) { changed = true; return; }
    call.revision = changed ? 'fresh-after-command' : 'stale-before-command'; reads++;
    if (reads === 1) await held;
  };
  f.state.bridgeResponse = (res, call) => {
    const data = snapshot(); data.revision = call.revision || 'command-only';
    reply(res, 200, call.body ? { ok: true, message: 'Updated.', snapshot: data } : data);
  };
  const opening = stream(f.base, first.cookie); opening.catch(() => {});
  await until(() => reads === 1);
  assert.equal((await sendCommand(f, second)).status, 200);
  // A new same-actor stream must not join the still-pending pre-command read.
  const b = await stream(f.base, second.cookie); t.after(b.close);
  await until(() => b.text.includes('fresh-after-command'));
  assert.equal(reads, 2); assert.equal(b.text.includes('stale-before-command'), false);
  release(); const a = await opening; t.after(a.close);
  await until(() => a.text.includes('fresh-after-command'));
  assert.deepEqual(streamSnapshots(a).map(data => data.revision), ['stale-before-command', 'fresh-after-command']);
  assert.equal(reads, 3);
});

test('Command-triggered reads preserve transient backoff, heartbeats and terminal permission loss without replay', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { pollMs: 200, pollRetryMaxMs: 800, heartbeatMs: 25 } });
  const device = await f.login(); const live = await stream(f.base, device.cookie); t.after(live.close);
  await until(() => streamSnapshots(live).length === 1);
  let readStatus = 503; let reads = 0;
  f.state.bridgeResponse = (res, call) => {
    if (call.body) reply(res, 200, { ok: true, message: 'Updated.', snapshot: snapshot() });
    else { reads++; reply(res, readStatus, { error: { code: 'private_failure', message: 'SECRET' } }); }
  };
  assert.equal((await sendCommand(f, device)).status, 200);
  await until(() => live.text.includes('"status":503'));
  const before = live.text.length;
  for (let i = 0; i < 5; i++) assert.equal((await sendCommand(f, device)).status, 200);
  await delay(160);
  assert.equal(reads, 1, 'Successful commands must not bypass the 400ms retry delay');
  assert.ok((live.text.slice(before).match(/heartbeat/g) || []).length >= 3);
  assert.equal(streamSnapshots(live).length, 1, 'Neither cached state nor acting snapshots may be replayed');
  readStatus = 403;
  await until(() => live.ended);
  assert.equal(reads, 2); assert.match(live.text, /"status":403/);
  assert.equal(live.text.includes('SECRET'), false);
  assert.equal(f.app.resourceCounts().streams, 0);
  const calls = f.state.calls.length; await delay(250); assert.equal(f.state.calls.length, calls);
  assert.equal(f.state.calls.filter(call => call.body).length, 6, 'No command may replay during recovery');
});

test('Failed, invalid and uncertain command results never wake SSE or replay writes', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { pollMs: 10_000, commandMs: 100 } }); const device = await f.login();
  const live = await stream(f.base, device.cookie); t.after(live.close);
  await until(() => streamSnapshots(live).length === 1);
  const before = f.state.calls.length;
  for (const [status, data] of [
    [409, { error: { code: 'private_failure' } }],
    [200, { ok: false, message: 'Rejected.', snapshot: snapshot() }],
    [200, { ok: true, message: 'Invalid snapshot.', snapshot: { ...snapshot(), guild: { id: 'other' } } }],
  ]) {
    f.state.bridgeResponse = res => reply(res, status, data);
    assert.equal((await sendCommand(f, device)).status, status === 409 ? 409 : 503);
  }
  f.state.beforeReply = async () => { await delay(200); };
  assert.equal((await sendCommand(f, device)).status, 503);
  await delay(250);
  assert.equal(f.state.calls.length - before, 4, 'Only four explicit writes may reach the bridge');
  assert.ok(f.state.calls.slice(before).every(call => call.body));
  assert.equal(streamSnapshots(live).length, 1);
});

test('Session revocation cancels a command-triggered read before it returns protected state', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { pollMs: 10_000 } }); const acting = await f.login(); const viewing = await f.login();
  const live = await stream(f.base, viewing.cookie); t.after(live.close);
  await until(() => streamSnapshots(live).length === 1);
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(release);
  let reading = false;
  f.state.beforeReply = async call => { if (!call.body) { reading = true; await held; } };
  assert.equal((await sendCommand(f, acting)).status, 200);
  await until(() => reading);
  assert.equal((await f.request('/auth/logout', { method: 'POST', headers: {
    Cookie: viewing.cookie, Origin: origin, 'X-CSRF-Token': viewing.csrf } })).status, 200);
  await until(() => live.ended && f.app.resourceCounts().upstream === 0);
  f.state.snapshot.revision = 'protected-after-logout'; release(); await delay(100);
  assert.equal(streamSnapshots(live).length, 1); assert.equal(live.text.includes('protected-after-logout'), false);
  assert.equal(f.app.resourceCounts().streams, 0);
});

test('OAuth uses exact callback, state-bound browser cookie, minimal scope, and secure seven-day sessions', { timeout: 5000 }, async t => {
  const f = await fixture(t); const device = await f.login();
  const authorize = new URL(device.pending.response.headers.location);
  assert.equal(authorize.origin, 'https://discord.com'); assert.equal(authorize.searchParams.get('response_type'), 'code');
  assert.equal(authorize.searchParams.get('redirect_uri'), `${origin}/auth/discord/callback`);
  assert.equal(authorize.searchParams.get('scope'), 'identify'); assert.equal(authorize.searchParams.has('code_challenge'), false);
  assert.equal(f.state.tokenCalls[0].get('redirect_uri'), `${origin}/auth/discord/callback`);
  assert.equal(f.state.tokenCalls[0].get('client_secret'), secret);
  assert.equal(device.response.headers.location, '/');
  const sessionHeader = device.response.headers['set-cookie'].find(value => value.startsWith(SESSION_COOKIE));
  assert.match(sessionHeader, /Max-Age=604800; Secure; HttpOnly; SameSite=Lax/);
  assert.equal(device.response.headers['cache-control'], 'no-store'); assert.equal(device.response.headers['referrer-policy'], 'no-referrer');
  assert.ok(f.state.calls.every(call => call.params.get('actorId') === actorId));
});

test('OAuth callback accepts the RFC 9207 issuer Discord appends', { timeout: 5000 }, async t => {
  const f = await fixture(t); const pending = await f.begin();
  const response = await f.request(`/auth/discord/callback?code=valid-code&state=${pending.state}&iss=https%3A%2F%2Fdiscord.com`, { headers: { Cookie: pending.cookie } });
  assert.equal(response.status, 302, response.text); assert.equal(response.headers.location, '/');
  assert.ok(cookieValue(response, SESSION_COOKIE));
});

test('OAuth missing/wrong/replayed state and duplicated query input fail before token exchange', { timeout: 5000 }, async t => {
  const f = await fixture(t); const pending = await f.begin();
  assert.equal((await f.request(`/auth/discord/callback?code=a&state=${pending.state}`)).status, 400);
  assert.equal((await f.request(`/auth/discord/callback?code=a&state=wrong`, { headers: { Cookie: pending.cookie } })).status, 400);
  assert.equal((await f.request(`/auth/discord/callback?code=a&state=${pending.state}`, { headers: { Cookie: pending.cookie } })).status, 400);
  const duplicate = await f.begin();
  assert.equal((await f.request(`/auth/discord/callback?code=a&code=b&state=${duplicate.state}`, { headers: { Cookie: duplicate.cookie } })).status, 400);
  const wrongIssuer = await f.begin();
  assert.equal((await f.request(`/auth/discord/callback?code=a&state=${wrongIssuer.state}&iss=https%3A%2F%2Fevil.example`, { headers: { Cookie: wrongIssuer.cookie } })).status, 400);
  assert.equal(f.state.tokenCalls.length, 0);
  const valid = await f.login();
  assert.equal((await f.request(`/auth/discord/callback?code=valid-code&state=${valid.pending.state}`, { headers: { Cookie: valid.pending.cookie } })).status, 400);
  assert.equal(f.state.tokenCalls.length, 1);
});

test('OAuth denial, expired state, invalid identity and fresh bot authorization cannot establish sessions', { timeout: 5000 }, async t => {
  let now = Date.now(); const f = await fixture(t, { now: () => now });
  const pending = await f.begin(); now += LIMITS.oauthMs + 1;
  assert.equal((await f.request(`/auth/discord/callback?code=a&state=${pending.state}`, { headers: { Cookie: pending.cookie } })).status, 400);
  const denied = await f.begin();
  assert.equal((await f.request(`/auth/discord/callback?error=access_denied&state=${denied.state}`, { headers: { Cookie: denied.cookie } })).status, 401);
  f.state.identity = 'invalid'; const invalidIdentity = await f.begin();
  assert.equal((await f.request(`/auth/discord/callback?code=a&state=${invalidIdentity.state}`, { headers: { Cookie: invalidIdentity.cookie } })).status, 503);
  f.state.identity = actorId; f.state.authorized = false; const disallowed = await f.begin();
  assert.equal((await f.request(`/auth/discord/callback?code=a&state=${disallowed.state}`, { headers: { Cookie: disallowed.cookie } })).status, 403);
  assert.equal((await f.request('/api/bootstrap')).status, 401);
});

test('Device session rotation prevents fixation; encrypted auth survives restart and expires after seven days', { timeout: 5000 }, async t => {
  let now = Date.now(); const f = await fixture(t, { now: () => now });
  const first = await f.login(); const second = await f.login(first.cookie);
  assert.notEqual(first.cookie, second.cookie); assert.notEqual(first.csrf, second.csrf);
  assert.equal((await f.request('/api/bootstrap', { headers: { Cookie: first.cookie } })).status, 401);
  const file = await fs.readFile(path.join(f.config.dataDir, 'sessions.enc'));
  for (const privateValue of [actorId, second.cookie.split('=')[1], second.csrf, 'private-oauth-token', 'private-refresh-token']) assert.equal(file.includes(Buffer.from(privateValue)), false);
  await f.restart();
  assert.equal((await f.request('/api/bootstrap', { headers: { Cookie: second.cookie } })).status, 200);
  now += LIMITS.sessionMs + 1;
  assert.equal((await f.request('/api/bootstrap', { headers: { Cookie: second.cookie } })).status, 401);
});

test('Logout needs exact origin and CSRF, closes device streams, and preserves another device', { timeout: 5000 }, async t => {
  const f = await fixture(t); const first = await f.login(); const second = await f.login();
  const live = await stream(f.base, first.cookie); t.after(live.close);
  await until(() => live.text.includes('event:snapshot'));
  assert.equal((await f.request('/auth/logout', { method: 'POST', headers: { Cookie: first.cookie, Origin: origin } })).status, 403);
  assert.equal((await f.request('/auth/logout', { method: 'POST', headers: { Cookie: first.cookie, Origin: `${origin}/`, 'X-CSRF-Token': first.csrf } })).status, 403);
  const result = await f.request('/auth/logout', { method: 'POST', headers: { Cookie: first.cookie, Origin: origin, 'X-CSRF-Token': first.csrf } });
  assert.equal(result.status, 200); assert.match(result.headers['set-cookie'][0], /Max-Age=0/);
  await until(() => live.ended && f.app.resourceCounts().streams === 0);
  assert.equal((await f.request('/api/bootstrap', { headers: { Cookie: first.cookie } })).status, 401);
  assert.equal((await f.request('/api/bootstrap', { headers: { Cookie: second.cookie } })).status, 200);
});

test('Mutations require exact origin and CSRF; browser actors and authority fields never reach bridge', { timeout: 5000 }, async t => {
  const f = await fixture(t); const device = await f.login();
  const base = { Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf, 'Content-Type': 'application/json' };
  const route = `/api/guilds/${guildId}/commands`; const callsBefore = f.state.calls.length;
  for (const headers of [{ ...base, Origin: 'https://evil.test' }, { ...base, Origin: 'null' },
    { ...base, Origin: undefined }, { ...base, 'X-CSRF-Token': 'wrong' }, { ...base, 'Sec-Fetch-Site': 'cross-site' }]) {
    const safeHeaders = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
    assert.equal((await f.request(route, { method: 'POST', headers: safeHeaders, body: '{"command":"stop"}' })).status, 403);
  }
  for (const body of [{ command: 'stop', actorId: '999' }, { command: 'stop', roles: ['admin'] },
    { command: 'stop', maintainer: true }, { command: 'stop', voice: 'x' }, { command: 'stop', options: { actorId: '999' } }]) {
    assert.equal((await f.request(route, { method: 'POST', headers: base, body: JSON.stringify(body) })).status, 400);
  }
  assert.equal((await f.request(`${route}?actorId=999`, { method: 'POST', headers: base, body: '{"command":"stop"}' })).status, 400);
  assert.equal((await f.request(`/api/guilds/${guildId}?actorId=999`, { headers: { Cookie: device.cookie } })).status, 400);
  assert.equal(f.state.calls.length, callsBefore);
  const result = await f.request(route, { method: 'POST', headers: { ...base, Authorization: 'Bearer browser-secret', 'X-Actor-Id': '999' }, body: '{"command":"stop"}' });
  assert.equal(result.status, 200); assert.equal(result.json().snapshot.guild.id, guildId);
  const call = f.state.calls.at(-1); assert.equal(call.body.actorId, actorId); assert.equal(call.authorization, `Bearer ${secret}`);
  assert.equal(call.params.has('actorId'), false);
});

test('Actual HTTP routes forward exact contract shapes, bounded search and fresh permissions', { timeout: 5000 }, async t => {
  const f = await fixture(t); const device = await f.login(); const headers = { Cookie: device.cookie };
  for (const resource of ['', '/configuration', '/library', '/search?query=rain%20mix', '/diagnostics', '/activity']) {
    const response = await f.request(`/api/guilds/${guildId}${resource}`, { headers });
    assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(f.state.calls.at(-1).params.get('actorId'), actorId);
  }
  assert.equal((await f.request(`/api/guilds/${guildId}/search?query=a&query=b`, { headers })).status, 400);
  const before = f.state.calls.length; f.state.authorized = false;
  for (const resource of ['', '/configuration', '/library', '/diagnostics', '/activity']) {
    const denied = await f.request(`/api/guilds/${guildId}${resource}`, { headers });
    assert.equal(denied.status, 403); assert.equal(denied.text.includes('SECRET'), false);
  }
  assert.equal(f.state.calls.length, before + 5);
});

test('API responses carry Server-Timing with only fixed metric names and durations', { timeout: 5000 }, async t => {
  const f = await fixture(t); const device = await f.login(); const headers = { Cookie: device.cookie };
  f.state.serverTiming = 'bot;dur=12.5, discord;dur=4';
  const metric = name => `${name};dur=\\d{1,7}\\.\\d`;
  const full = new RegExp(`^${['portal', 'bridge', 'bot', 'discord'].map(metric).join(', ')}$`);
  const responses = [];
  for (const resource of ['/api/bootstrap', `/api/guilds/${guildId}`, `/api/guilds/${guildId}/library`,
    `/api/guilds/${guildId}/stats?window=7d`, `/api/guilds/${guildId}/recap`]) responses.push([resource, await f.request(resource, { headers })]);
  responses.push(['commands', await sendCommand(f, device)]);
  for (const [resource, response] of responses) {
    assert.equal(response.status, 200, resource);
    const timing = response.headers['server-timing'];
    assert.match(timing, full, resource);
    assert.match(timing, /bot;dur=12\.5, discord;dur=4\.0$/);
    // Nothing identifying: no snowflakes, names or response content.
    for (const secretValue of [actorId, guildId, 'listener', 'Private guild', 'revision-1']) assert.equal(timing.includes(secretValue), false);
    assert.equal(response.headers['timing-allow-origin'], undefined);
    assert.match(response.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  // Missing or malformed bot timing is dropped, never forwarded or fatal.
  for (const upstream of ['bot;dur=abc, evil;dur=5', `discord;dur=1;desc="${actorId}"`, 'x'.repeat(300)]) {
    f.state.serverTiming = upstream;
    const response = await f.request(`/api/guilds/${guildId}/library`, { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers['server-timing'], new RegExp(`^${metric('portal')}, ${metric('bridge')}$`));
  }
  // A live stream may join a read already in flight, so its bot numbers are not merged.
  f.state.serverTiming = 'bot;dur=12.5, discord;dur=4';
  const live = await stream(f.base, device.cookie); t.after(live.close);
  assert.equal(live.res.statusCode, 200);
  assert.match(live.res.headers['server-timing'], new RegExp(`^${metric('portal')}, ${metric('bridge')}$`));
  delete f.state.serverTiming;
  const failed = await f.request(`/api/guilds/${guildId}/nope`, { headers });
  assert.equal(failed.status, 404); assert.match(failed.headers['server-timing'], new RegExp(`^${metric('portal')}$`));
  // Static files and sign-in routes are not API responses.
  assert.equal((await f.request('/')).headers['server-timing'], undefined);
  assert.equal((await f.request('/health')).headers['server-timing'], undefined);
});

test('Upstream timing parser keeps only known bot metrics', () => {
  assert.deepEqual(parseUpstreamTiming('bot;dur=10.25, discord;dur=3, bot;dur=1'), { bot: 11.25, discord: 3 });
  assert.deepEqual(parseUpstreamTiming('bot;dur=-1, discord;dur=1e9, lane;dur=2, bot ; dur=1'), {});
  for (const value of [undefined, null, 42, ['bot;dur=1'], '', 'bot;dur=1,'.repeat(40)]) assert.deepEqual(parseUpstreamTiming(value), {});
});

test('Configuration discovery derives identity from the device session and never accepts client authority', { timeout: 5000 }, async t => {
  const f = await fixture(t); const route = `/api/guilds/${guildId}/configuration`;
  const anonymousCalls = f.state.calls.length;
  assert.equal((await f.request(route)).status, 401); assert.equal(f.state.calls.length, anonymousCalls);
  const device = await f.login(); const headers = { Cookie: device.cookie };
  const before = f.state.calls.length;
  for (const query of ['actorId=999', 'admin=true', 'scope=configuration', 'guildId=999']) {
    assert.equal((await f.request(`${route}?${query}`, { headers })).status, 400);
  }
  assert.equal(f.state.calls.length, before);
  const response = await f.request(route, { headers });
  assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json(), { guildId, channels: [{ id: '456789012345678901', name: 'Music', type: 'text' }], roles: [] });
  const call = f.state.calls.at(-1);
  assert.equal(call.path, `/v1/guilds/${guildId}/configuration`); assert.deepEqual([...call.params], [['actorId', actorId]]);
  assert.equal(call.body, null); assert.equal(call.authorization, `Bearer ${secret}`);
  f.state.authorized = false;
  const revoked = await f.request(route, { headers });
  assert.equal(revoked.status, 403); assert.equal(revoked.text.includes('SECRET'), false); assert.equal(revoked.text.includes('Music'), false);
  assert.equal(f.state.calls.length, before + 2, 'Discovery must freshly authorize every read');
});

test('Logout during configuration discovery prevents the pending catalog from reaching the browser', { timeout: 5000 }, async t => {
  const f = await fixture(t); const device = await f.login(); let release; let entered = false;
  f.state.beforeReply = async call => {
    if (call.path.endsWith('/configuration')) { entered = true; await new Promise(resolve => { release = resolve; }); }
  };
  t.after(() => release?.());
  const pending = f.request(`/api/guilds/${guildId}/configuration`, { headers: { Cookie: device.cookie } });
  await until(() => entered);
  const logout = await f.request('/auth/logout', { method: 'POST', headers: { Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf } });
  assert.equal(logout.status, 200); release();
  const response = await pending; assert.equal(response.status, 401);
  assert.equal(response.text.includes('channels'), false); assert.equal(response.text.includes('Music'), false);
});

test('Configuration transport rejects cross-guild, malformed and oversized catalogs without exposing their contents', { timeout: 5000 }, async t => {
  const f = await fixture(t); const device = await f.login(); const route = `/api/guilds/${guildId}/configuration`;
  const validChannel = { id: '456789012345678901', name: 'SECRET channel', type: 'text' };
  for (const data of [
    { guildId: '999', channels: [validChannel], roles: [] },
    { guildId, channels: [{ ...validChannel, id: 123 }], roles: [] },
    { guildId, channels: [{ ...validChannel, type: 'category' }], roles: [] },
    { guildId, channels: Array.from({ length: 501 }, () => validChannel), roles: [] },
    { guildId, channels: [], roles: Array.from({ length: 251 }, () => ({ id: '1', name: 'SECRET role' })) },
  ]) {
    f.state.bridgeResponse = res => reply(res, 200, data);
    const response = await f.request(route, { headers: { Cookie: device.cookie } });
    assert.equal(response.status, 503); assert.equal(response.text.includes('SECRET'), false);
  }
});

test('Command whitelist, revision conflicts, size/type bounds, and offline writes are fail-closed without replay', { timeout: 5000 }, async t => {
  const f = await fixture(t); const device = await f.login(); const route = `/api/guilds/${guildId}/commands`;
  const headers = { Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf, 'Content-Type': 'application/json' };
  const send = body => f.request(route, { method: 'POST', headers, body: JSON.stringify(body) });
  for (const body of [{ command: 'unknown' }, { command: 'move', options: { from: 1, to: 2 } },
    { command: 'move', options: { from: 0, to: 2 }, expectedRevision: 'v1' }, { command: 'volume', options: { level: 101 } },
    { command: 'loop', options: { mode: 'all' } }, { command: 'stop', options: { '__proto__': 'admin', extra: true } }]) assert.equal((await send(body)).status, 400);
  assert.equal((await f.request(route, { method: 'POST', headers, body: 'x'.repeat(LIMITS.bodyBytes + 1) })).status, 400);
  assert.equal((await f.request(route, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 400);
  assert.equal((await send({ command: 'skipto', options: { position: 2 }, expectedRevision: 'v1' })).status, 200);
  assert.equal(f.state.calls.at(-1).body.options.position, 2);
  assert.equal((await send({ command: 'replay', options: { index: 1 }, expectedRevision: 'v1', expectedHistoryId: 'history-1' })).status, 200);
  assert.equal((await send({ command: 'settings', subcommand: 'musicchannel', options: { channel: guildId } })).status, 200);
  f.state.status = 409;
  assert.equal((await send({ command: 'remove', options: { position: 1 }, expectedRevision: 'old' })).status, 409);
  f.state.status = 503; const count = f.state.calls.length;
  assert.equal((await send({ command: 'stop' })).status, 503);
  f.state.status = null; await delay(50); assert.equal(f.state.calls.length, count + 1);
});

test('SSE emits fresh snapshots and heartbeat then closes on permission loss and disconnect', { timeout: 5000 }, async t => {
  const f = await fixture(t); const device = await f.login(); const live = await stream(f.base, device.cookie); t.after(live.close);
  assert.equal(live.res.statusCode, 200); assert.equal(live.res.headers['cache-control'], 'no-store');
  await until(() => live.text.includes(': heartbeat') && f.state.calls.filter(call => call.path === `/v1/guilds/${guildId}`).length >= 3);
  const pollCalls = f.state.calls.filter(call => call.path === `/v1/guilds/${guildId}`);
  assert.ok(pollCalls.length >= 3); assert.ok(pollCalls.every(call => call.params.get('actorId') === actorId));
  f.state.authorized = false;
  await until(() => live.ended); assert.match(live.text, /event:error/); assert.match(live.text, /forbidden/);
  assert.equal(live.text.includes('SECRET'), false); assert.equal(f.app.resourceCounts().streams, 0);
  const before = f.state.calls.length; await delay(80); assert.equal(f.state.calls.length, before);
  const denied = await f.request(`/api/guilds/${guildId}/events`, { headers: { Cookie: device.cookie } });
  assert.equal(denied.status, 403); assert.equal(denied.json().error.code, 'forbidden');
  f.state.authorized = true; const other = await stream(f.base, device.cookie); await until(() => other.text.includes('snapshot'));
  other.close(); await until(() => f.app.resourceCounts().streams === 0 && f.app.resourceCounts().upstream === 0);
  const after = f.state.calls.length; await delay(80); assert.equal(f.state.calls.length, after);
});

test('SSE bounds global/device connections, snapshot bytes and session lifetime', { timeout: 5000 }, async t => {
  let now = Date.now(); const f = await fixture(t, { now: () => now, limits: { streams: 2, streamsPerSession: 1, snapshotBytes: 2000 } });
  const first = await f.login(); const second = await f.login(); const third = await f.login();
  const firstStream = await stream(f.base, first.cookie); const secondStream = await stream(f.base, second.cookie);
  t.after(firstStream.close); t.after(secondStream.close);
  await until(() => firstStream.text.includes('snapshot') && secondStream.text.includes('snapshot'));
  assert.equal((await f.request(`/api/guilds/${guildId}/events`, { headers: { Cookie: first.cookie } })).status, 429);
  assert.equal((await f.request(`/api/guilds/${guildId}/events`, { headers: { Cookie: third.cookie } })).status, 429);
  now += LIMITS.sessionMs + 1; await until(() => firstStream.ended && secondStream.ended);
  assert.equal(f.app.resourceCounts().streams, 0);
  const valid = await f.login(); f.state.snapshot.session.reason = 'x'.repeat(3000);
  assert.equal((await f.request(`/api/guilds/${guildId}/events`, { headers: { Cookie: valid.cookie } })).status, 503);
  assert.equal(f.app.resourceCounts().streams, 0);
});

test('SSE slow readers are closed without unbounded polling or buffered snapshots', { timeout: 7000 }, async t => {
  const f = await fixture(t, { limits: { pollMs: 10, drainMs: 100, snapshotBytes: 1024 * 1024 } });
  const device = await f.login(); f.state.snapshot.session.reason = 'x'.repeat(800 * 1024);
  const socket = net.connect(new URL(f.base).port, '127.0.0.1'); t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write(`GET /api/guilds/${guildId}/events HTTP/1.1\r\nHost: localhost\r\nCookie: ${device.cookie}\r\n\r\n`);
  socket.pause();
  await until(() => f.app.resourceCounts().streams === 1);
  await until(() => f.app.resourceCounts().streams === 0, 4500);
  const polls = f.state.calls.filter(call => call.path === `/v1/guilds/${guildId}`).length;
  assert.ok(polls <= 10, `Slow consumer caused ${polls} unbounded polls`);
  const count = f.state.calls.length; await delay(100); assert.equal(f.state.calls.length, count);
});

test('Upstream deadlines, response size and malformed payload are contained; health reports readiness safely', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { upstreamMs: 60, commandMs: 60, upstreamBytes: 2048 } });
  const device = await f.login(); const headers = { Cookie: device.cookie };
  const healthy = await f.request('/health'); assert.equal(healthy.status, 200); assert.equal(healthy.json().ready, true);
  assert.equal(healthy.text.includes(actorId), false);
  f.state.raw = 'x'.repeat(2500); assert.equal((await f.request('/api/bootstrap', { headers })).status, 503);
  f.state.raw = '{bad-json'; assert.equal((await f.request('/api/bootstrap', { headers })).status, 503);
  f.state.raw = null; f.state.delayMs = 250;
  assert.equal((await f.request('/api/bootstrap', { headers })).status, 503);
  await until(() => f.app.resourceCounts().upstream === 0);
  assert.equal((await f.request('/health')).status, 503);
});

test('Rate and concurrency limits return safe no-store 429 without upstream fanout', { timeout: 7000 }, async t => {
  const f = await fixture(t, { limits: { upstream: 1, upstreamMs: 500 } }); const device = await f.login();
  f.state.delayMs = 100;
  const first = f.request('/api/bootstrap', { headers: { Cookie: device.cookie } });
  await until(() => f.app.resourceCounts().upstream === 1);
  const second = await f.request('/api/bootstrap', { headers: { Cookie: device.cookie } });
  assert.equal(second.status, 429); assert.equal(second.headers['cache-control'], 'no-store'); assert.equal(second.headers['retry-after'], '5');
  assert.equal((await first).status, 200); f.state.delayMs = 0;
  const headers = { Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf, 'Content-Type': 'application/json' };
  const results = [];
  for (let i = 0; i < 31; i++) results.push(await f.request(`/api/guilds/${guildId}/commands`, { method: 'POST', headers, body: '{"command":"pause"}' }));
  assert.equal(results.at(-1).status, 429); assert.equal(f.state.calls.filter(call => call.body?.command === 'pause').length, 30);
  const reads = await Promise.all(Array.from({ length: 121 }, () => f.request('/api/missing', { headers: { Cookie: device.cookie } })));
  assert.ok(reads.some(response => response.status === 429));
  assert.equal((await f.request('/api/bootstrap', { headers: { Cookie: device.cookie } })).status, 429);
  results.length = 0;
  for (let i = 0; i < 31; i++) results.push(await f.request(`/api/guilds/${guildId}/commands`, { method: 'POST', headers, body: '{"command":"stop"}' }));
  assert.ok(results.slice(0, 30).every(response => response.status === 200));
  assert.equal(results.at(-1).status, 429); assert.equal(f.state.calls.filter(call => call.body?.command === 'stop').length, 30);
});

test('Static serving blocks encoded/double-encoded traversal, hidden files, symlink escapes and API SPA fallback', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/')).status, 200); assert.equal((await f.request('/guilds/123')).status, 200);
  assert.equal((await f.request('/app-abcdefgh.js', { method: 'HEAD' })).headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await f.request('/sw.js')).headers['cache-control'], 'no-store');
  // The PWA share target carries shared text in its query: never let a browser cache keep it.
  const shared = await f.request('/share?text=' + encodeURIComponent('https://youtu.be/abcdefghijk'));
  assert.equal(shared.status, 200); assert.equal(shared.headers['cache-control'], 'no-store');
  assert.equal((await f.request('/guilds/123')).headers['cache-control'], 'no-cache');
  for (const pathname of ['/../outside.txt', '/%2e%2e/outside.txt', '/%252e%252e/outside.txt', '/..%5coutside.txt', '/%00', '/%xy', '//outside.txt']) assert.equal((await f.request(pathname)).status, 400, pathname);
  for (const pathname of ['/.env', '/missing.js', '/app.js.map']) assert.equal((await f.request(pathname)).status, 404, pathname);
  assert.equal((await f.request('/api/missing')).status, 401);
  assert.equal((await f.request('/auth/missing')).status, 404);
  const forbidden = path.join(f.config.webDist, 'escape.js');
  try { await fs.symlink(path.join(path.dirname(f.config.webDist), 'outside.txt'), forbidden); }
  catch (error) { if (error.code !== 'EPERM') throw error; t.diagnostic('File symlink requires Windows privilege; directory junction escape still covered below.'); }
  if (await fs.lstat(forbidden).catch(() => null)) assert.equal((await f.request('/escape.js')).status, 404);
  const outsideDir = path.join(path.dirname(f.config.webDist), 'private'); await fs.mkdir(outsideDir); await fs.writeFile(path.join(outsideDir, 'secret.js'), 'private');
  await fs.symlink(outsideDir, path.join(f.config.webDist, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.request('/outside/secret.js')).status, 404);
  const secured = await f.request('/');
  assert.match(secured.headers['content-security-policy'], /media-src 'self'/); assert.match(secured.headers['content-security-policy'], /script-src 'self'; style-src/); assert.doesNotMatch(secured.headers['content-security-policy'], /youtube|frame-src/); assert.equal(secured.headers['x-frame-options'], 'DENY');
  assert.equal(secured.headers['access-control-allow-origin'], undefined);
});

test('Completed static GET and HEAD responses preserve subsequent HTTP connections', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  for (let batch = 0; batch < 12; batch++) {
    const [shell, script, head] = await Promise.all([
      f.request('/'), f.request('/app-abcdefgh.js'), f.request('/app-abcdefgh.js', { method: 'HEAD' }),
    ]);
    assert.equal(shell.status, 200); assert.match(shell.text, /Portal shell/);
    assert.equal(script.status, 200); assert.equal(script.text, 'window.portal = true;');
    assert.equal(head.status, 200); assert.equal(head.text, '');
    assert.equal(head.headers['content-length'], script.headers['content-length']);
    assert.equal(head.headers['content-type'], script.headers['content-type']);
    assert.equal((await f.request('/guilds/123')).text, shell.text);
    assert.equal((await f.request('/api/bootstrap')).status, 401);
  }
});

test('Static files are sent precompressed, revalidate with ETags, and only hashed build assets are immutable', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const dist = f.config.webDist;
  const write = async (name, data) => { await fs.mkdir(path.dirname(path.join(dist, name)), { recursive: true }); await fs.writeFile(path.join(dist, name), data); };
  const script = Buffer.from(`window.portal = "${'compressible '.repeat(200)}";`);
  await write('assets/index-Ab_9-xYz.js', script);
  await write('assets/index-Ab_9-xYz.js.br', brotliCompressSync(script));
  await write('assets/index-Ab_9-xYz.js.gz', gzipSync(script));
  await write('index.html.br', brotliCompressSync(await fs.readFile(path.join(dist, 'index.html'))));
  await write('assets/fallback-cover-320-Dw5JH-Cp.webp', 'RIFF-cover');
  await write('icons/apple-touch-icon.png', 'png');
  await write('manifest.webmanifest', '{"name":"Vybatron"}');
  const get = (pathname, headers = {}, method = 'GET') => f.request(pathname, { method, headers });
  const scriptPath = '/assets/index-Ab_9-xYz.js';

  // The browser's usual header gets brotli; the body and length are the encoded file's.
  const brotli = await get(scriptPath, { 'Accept-Encoding': 'gzip, deflate, br, zstd' });
  assert.equal(brotli.status, 200); assert.equal(brotli.headers['content-encoding'], 'br');
  assert.equal(brotli.headers.vary, 'Accept-Encoding');
  assert.equal(Number(brotli.headers['content-length']), brotli.body.length);
  assert.ok(brotli.body.length < script.length);
  assert.deepEqual(brotliDecompressSync(brotli.body), script);
  assert.equal(brotli.headers['cache-control'], 'public, max-age=31536000, immutable');
  // Chromium treats Pragma: no-cache as "always revalidate", which would defeat immutable.
  assert.equal(brotli.headers.pragma, undefined);
  assert.match(brotli.headers.etag, /^"[\w-]{32}-br"$/);
  // gzip when brotli is refused or unknown; identity when nothing is accepted.
  for (const accept of ['gzip', 'br;q=0, gzip;q=0.5', 'gzip;q=1, br;q=0.4, *;q=0']) {
    const gzip = await get(scriptPath, { 'Accept-Encoding': accept });
    assert.equal(gzip.headers['content-encoding'], 'gzip', accept); assert.deepEqual(gunzipSync(gzip.body), script);
    assert.match(gzip.headers.etag, /-gz"$/);
  }
  for (const accept of [undefined, 'identity', 'br;q=0, gzip;q=0', 'zstd']) {
    const plain = await get(scriptPath, accept ? { 'Accept-Encoding': accept } : {});
    assert.equal(plain.headers['content-encoding'], undefined, accept); assert.deepEqual(plain.body, script);
    assert.equal(Number(plain.headers['content-length']), script.length); assert.equal(plain.headers.vary, 'Accept-Encoding');
  }
  const head = await get(scriptPath, { 'Accept-Encoding': 'br' }, 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-encoding'], 'br'); assert.equal(head.headers['content-length'], brotli.headers['content-length']);
  assert.equal(head.headers.etag, brotli.headers.etag);
  // Static files ignore byte ranges: the whole representation, never a partial one.
  const ranged = await get(scriptPath, { Range: 'bytes=0-9' });
  assert.equal(ranged.status, 200); assert.deepEqual(ranged.body, script);

  // Revalidation: a matching tag (weak or strong, alone or in a list) is a bodyless 304.
  for (const tag of [brotli.headers.etag, `W/${brotli.headers.etag}`, `"other", ${brotli.headers.etag}`, '*']) {
    const cached = await get(scriptPath, { 'Accept-Encoding': 'br', 'If-None-Match': tag });
    assert.equal(cached.status, 304, tag); assert.equal(cached.body.length, 0);
    assert.equal(cached.headers.etag, brotli.headers.etag); assert.equal(cached.headers.vary, 'Accept-Encoding');
    assert.equal(cached.headers['cache-control'], 'public, max-age=31536000, immutable');
  }
  // Each encoding is its own representation.
  const otherCoding = await get(scriptPath, { 'Accept-Encoding': 'gzip', 'If-None-Match': brotli.headers.etag });
  assert.equal(otherCoding.status, 200); assert.equal(otherCoding.headers['content-encoding'], 'gzip');
  // Recompressing the same source differently is a different representation with a new validator.
  await write('assets/index-Ab_9-xYz.js.gz', gzipSync(script, { level: 1 }));
  const recompressed = await get(scriptPath, { 'Accept-Encoding': 'gzip', 'If-None-Match': otherCoding.headers.etag });
  assert.equal(recompressed.status, 200); assert.notEqual(recompressed.headers.etag, otherCoding.headers.etag);
  assert.deepEqual(gunzipSync(recompressed.body), script);

  // The shell revalidates on every load and costs one 304 when unchanged, including SPA routes.
  const shell = await get('/', { 'Accept-Encoding': 'br' });
  assert.equal(shell.headers['cache-control'], 'no-cache'); assert.equal(shell.headers['content-encoding'], 'br'); assert.equal(shell.headers.pragma, undefined);
  assert.match(brotliDecompressSync(shell.body).toString(), /Portal shell/);
  for (const pathname of ['/', '/guilds/123', '/index.html']) {
    const revalidated = await get(pathname, { 'Accept-Encoding': 'br', 'If-None-Match': shell.headers.etag });
    assert.equal(revalidated.status, 304, pathname); assert.equal(revalidated.headers['cache-control'], 'no-cache');
  }
  const manifest = await get('/manifest.webmanifest');
  assert.equal(manifest.headers['cache-control'], 'no-cache'); assert.match(manifest.headers.etag, /^"[\w-]{32}"$/);
  assert.equal((await get('/manifest.webmanifest', { 'If-None-Match': manifest.headers.etag })).status, 304);
  // A changed file gets a new validator, so a stale copy is never confirmed.
  await write('manifest.webmanifest', '{"name":"Vybatron 2"}');
  const changed = await get('/manifest.webmanifest', { 'If-None-Match': manifest.headers.etag });
  assert.equal(changed.status, 200); assert.notEqual(changed.headers.etag, manifest.headers.etag); assert.equal(changed.text, '{"name":"Vybatron 2"}');

  // Immutable caching needs a Vite-hashed name inside /assets/; public files keep their names.
  assert.equal((await get('/assets/fallback-cover-320-Dw5JH-Cp.webp')).headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal((await get('/assets/fallback-cover-320-Dw5JH-Cp.webp')).headers.vary, undefined);
  for (const pathname of ['/icons/apple-touch-icon.png', '/app-abcdefgh.js']) assert.equal((await get(pathname)).headers['cache-control'], 'no-cache', pathname);
  // Encoded copies are not URLs of their own.
  for (const pathname of [`${scriptPath}.br`, `${scriptPath}.gz`, '/index.html.br']) assert.equal((await get(pathname)).status, 404, pathname);

  // A copy older than its original belongs to a previous build and is never served.
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(path.join(dist, 'index.html.br'), old, old);
  const stale = await get('/', { 'Accept-Encoding': 'br' });
  assert.equal(stale.headers['content-encoding'], undefined); assert.match(stale.text, /Portal shell/);

  // The worker script and the share target are never stored, so they carry no validator.
  for (const pathname of ['/sw.js', '/share?text=x']) {
    const fresh = await get(pathname, { 'If-None-Match': '*' });
    assert.equal(fresh.status, 200, pathname); assert.equal(fresh.headers['cache-control'], 'no-store'); assert.equal(fresh.headers.etag, undefined);
    assert.equal(fresh.headers.pragma, 'no-cache', pathname);
  }
});

test('Static metadata failure and disconnected readers release their opened files', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const failedFile = path.join(f.config.webDist, 'failed.js');
  const delayedFile = path.join(f.config.webDist, 'delayed.js');
  const largeFile = path.join(f.config.webDist, 'large.js');
  await fs.writeFile(failedFile, 'not served'); await fs.writeFile(delayedFile, 'not served');
  await fs.writeFile(largeFile, Buffer.alloc(2 * 1024 * 1024, 120));
  const handles = []; const open = fs.open.bind(fs);
  let unblock; const gate = new Promise(resolve => { unblock = resolve; }); t.after(unblock);
  t.mock.method(fs, 'open', async (filename, ...args) => {
    const handle = await open(filename, ...args);
    if ([failedFile, delayedFile, largeFile].includes(filename)) handles.push(handle);
    if (filename === failedFile) handle.stat = async () => { throw new Error('Injected metadata failure'); };
    if (filename === delayedFile) await gate;
    return handle;
  });
  const failed = await f.request('/failed.js');
  assert.equal(failed.status, 503); assert.equal(failed.headers['cache-control'], 'no-store');
  assert.equal(failed.text.includes('Injected'), false);
  await until(() => handles.length === 1 && handles.every(handle => handle.fd === -1));

  const accepted = once(f.app.server, 'connection');
  const early = http.get(`${f.base}/delayed.js`, { agent: false });
  early.on('error', () => {}); t.after(() => early.destroy());
  const [socket] = await accepted;
  const disconnected = new Promise(resolve => socket.once('close', resolve));
  await until(() => handles.length === 2);
  early.destroy(); await disconnected;
  unblock();
  await until(() => handles.every(handle => handle.fd === -1) && f.app.resourceCounts().requests === 0);

  await new Promise((resolve, reject) => {
    const req = http.get(`${f.base}/large.js`, { agent: false }, res => {
      res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
      res.on('error', reject);
    });
    req.setTimeout(2000, () => req.destroy(new Error('Static disconnect deadline')));
    req.on('error', reject); t.after(() => req.destroy());
  });
  await until(() => handles.length === 3 && handles.every(handle => handle.fd === -1));
  assert.equal((await f.request('/')).status, 200);
});

test('Production refuses test transports; config rejects insecure origin, malformed secrets, and default dist is sibling web/dist', { timeout: 5000 }, async () => {
  const env = { NODE_ENV: 'production', PORTAL_ORIGIN: origin, PORTAL_BOT_URL: 'http://bot:3010',
    PORTAL_BRIDGE_TOKEN: secret, DISCORD_CLIENT_SECRET: secret, DISCORD_CLIENT_ID: actorId, PORTAL_SESSION_SECRET: secret };
  const config = loadConfig(env);
  assert.ok(config.webDist.endsWith(path.join('portal', 'web', 'dist')));
  await assert.rejects(createPortalServer(config, { discordOrigin: 'http://127.0.0.1:9000' }), /forbidden/);
  assert.throws(() => loadConfig({ ...env, PORTAL_ORIGIN: 'http://127.0.0.1:3001' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...env, PORTAL_ORIGIN: `${origin}/` }), /exact/);
  assert.throws(() => loadConfig({ ...env, PORTAL_SESSION_SECRET: 'short' }), /secret material/);
  assert.throws(() => loadConfig({ ...env, PORTAL_BRIDGE_TOKEN: secret + '\n' }), /secret material/);
});

test('Encrypted storage corruption fails startup without falling back to plaintext or test auth', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.login(); await f.app.close();
  await fs.writeFile(path.join(f.config.dataDir, 'sessions.enc'), 'not-an-encrypted-session-store');
  await assert.rejects(createPortalServer(f.config), /safely opened/);
});

test('SSE transient bridge errors invalidate freshness and recover without reconnecting or replaying state', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { pollRetryMaxMs: 100 } }); const device = await f.login();
  const live = await stream(f.base, device.cookie); t.after(live.close);
  await until(() => live.text.includes('snapshot'));
  const snapshots = () => (live.text.match(/event:snapshot/g) || []).length;
  f.state.status = 503;
  await until(() => live.text.includes('event:error'));
  const before = snapshots(); const calls = f.state.calls.length;
  await delay(180);
  assert.equal(live.ended, false, 'A transient bridge error must not terminate EventSource');
  assert.equal(snapshots(), before, 'Previously authorized state must never be resent during failure');
  assert.ok(f.state.calls.length - calls <= 4, 'Read recovery must back off instead of amplifying upstream pressure');
  assert.match(live.text, /heartbeat/);
  f.state.status = 429;
  await until(() => live.text.includes('busy'));
  assert.equal(live.ended, false);
  f.state.snapshot.revision = 'revision-recovered'; f.state.status = null;
  await until(() => live.text.includes('revision-recovered'));
  assert.equal(live.ended, false);
  assert.equal(f.state.calls.some(call => call.body), false, 'Read recovery must never dispatch a command');
});

test('SSE retries an initially unavailable bridge without sending an unauthorized snapshot', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { pollRetryMaxMs: 100 } }); const device = await f.login();
  f.state.status = 503;
  const live = await stream(f.base, device.cookie); t.after(live.close);
  await until(() => live.text.includes('event:error') && live.text.includes('heartbeat'));
  assert.equal(live.res.statusCode, 200);
  assert.equal(live.text.includes('event:snapshot'), false);
  assert.match(live.text, /"status":503/);
  assert.equal(live.text.includes('SECRET'), false);
  f.state.status = null; f.state.snapshot.revision = 'first-authorized-state';
  await until(() => live.text.includes('first-authorized-state'));
  assert.equal(live.ended, false);
});

test('SSE invalid upstream responses are terminal before and after fresh state', { timeout: 15_000 }, async t => {
  const oversized = JSON.stringify({ ...snapshot(), privateDetail: 'SECRET'.repeat(500) });
  const faults = [
    { name: 'malformed JSON', body: '{SECRET bad-json' },
    { name: 'wrong content type', body: JSON.stringify(snapshot()), headers: { 'Content-Type': 'text/plain' } },
    { name: 'invalid top-level JSON', body: '["SECRET"]' },
    { name: 'oversized content length', body: oversized, headers: { 'Content-Length': Buffer.byteLength(oversized) } },
    { name: 'oversized chunked JSON', body: oversized, headers: { 'Transfer-Encoding': 'chunked' } },
    { name: 'unsupported encoding', body: JSON.stringify(snapshot()), headers: { 'Content-Encoding': 'gzip' } },
    { name: 'bridge projection limit', status: 503,
      body: JSON.stringify({ error: { code: 'projection_limit', message: 'SECRET upstream details' } }) },
    { name: 'missing snapshot revision', body: JSON.stringify({ ...snapshot(), revision: undefined }) },
  ];
  for (const fault of faults) for (const later of [false, true]) await t.test(`${fault.name} / ${later ? 'later poll' : 'initial read'}`, async t => {
    const f = await fixture(t, { limits: { pollMs: 20, pollRetryMaxMs: 80, heartbeatMs: 25, upstreamBytes: 2048 } });
    const device = await f.login(); let live;
    if (later) {
      live = await stream(f.base, device.cookie); t.after(live.close);
      await until(() => live.text.includes('event:snapshot'));
    }
    const before = f.state.calls.length;
    f.state.bridgeResponse = res => {
      res.writeHead(fault.status || 200, { 'Content-Type': 'application/json', ...fault.headers });
      res.end(fault.body);
    };
    if (!later) { live = await stream(f.base, device.cookie); t.after(live.close); }
    // The independent real-HTTP reproducer observed repeated polls within this
    // window. A rejected payload must instead close and release its stream slot.
    await delay(230);
    assert.equal(live.ended, true, 'An invalid upstream response must terminate the stream');
    assert.equal(live.res.statusCode, later ? 200 : 503);
    assert.equal(f.state.calls.length, before + 1, 'A terminal response must never schedule another bridge poll');
    assert.equal((live.text.match(/event:snapshot/g) || []).length, later ? 1 : 0);
    assert.equal((live.text.match(/event:error/g) || []).length, later ? 1 : 0);
    const payload = later ? JSON.parse(live.text.match(/event:error\ndata:([^\n]+)/)[1]) : JSON.parse(live.text);
    assert.equal(payload.error.code, 'unavailable');
    assert.equal(typeof payload.error.message, 'string');
    if (later) assert.equal(payload.error.status, 503);
    assert.equal(live.text.includes('SECRET'), false);
    assert.equal(live.text.includes('projection_limit'), false, 'Private bridge codes must not reach the browser');
    assert.equal(live.text.includes('retryable'), false, 'Retry classification is internal only');
    assert.equal(live.res.headers['cache-control'], 'no-store');
    assert.equal(f.app.resourceCounts().streams, 0);
    assert.equal(f.app.resourceCounts().upstream, 0);
    assert.equal(f.app.resourceCounts().requests, 0);
    const closed = live.text; await delay(100);
    assert.equal(live.text, closed, 'A terminal stream must stop its heartbeat timer');
    assert.equal(f.state.calls.length, before + 1);
    assert.equal(f.state.calls.some(call => call.body), false);
  });
});

test('SSE genuine transport and bridge outages back off and recover on the same initial or established stream', { timeout: 10_000 }, async t => {
  const faults = [
    { name: 'connection reset', send: res => res.destroy() },
    { name: 'upstream deadline', send: () => {} },
    { name: 'bridge unavailable', send: res => reply(res, 503, { error: { code: 'unavailable', message: 'SECRET bridge details' } }) },
    { name: 'unknown private code', send: res => reply(res, 503,
      { error: { code: 'SECRET_projection_limit_other', message: 'SECRET private failure', retryable: false }, retryable: false }) },
  ];
  for (const fault of faults) for (const later of [false, true]) await t.test(`${fault.name} / ${later ? 'later poll' : 'initial read'}`, async t => {
    const pollMs = 40;
    const f = await fixture(t, { limits: { pollMs, pollRetryMaxMs: 160, heartbeatMs: 25, upstreamMs: 100 } });
    const device = await f.login(); let live;
    if (later) {
      live = await stream(f.base, device.cookie); t.after(live.close);
      await until(() => live.text.includes('event:snapshot'));
    }
    const attempts = [];
    f.state.bridgeResponse = res => { attempts.push(Date.now()); fault.send(res); };
    if (!later) { live = await stream(f.base, device.cookie); t.after(live.close); }
    await until(() => (live.text.match(/event:error/g) || []).length >= 2);
    assert.equal(live.res.statusCode, 200);
    assert.equal(live.ended, false, 'A genuine outage must not terminate the EventSource response');
    // A reset on a reused keep-alive socket is retried once at once; that is the same read.
    const reads = attempts.filter((at, index) => index === 0 || at - attempts[index - 1] >= pollMs);
    assert.equal(reads.length, 2);
    assert.ok(attempts.length <= (fault.name === 'connection reset' ? 4 : 2), `${attempts.length} bridge attempts`);
    assert.ok(reads[1] - reads[0] >= 2 * pollMs - 10, 'Retry must use the doubled first backoff, allowing timer precision');
    assert.equal((live.text.match(/event:snapshot/g) || []).length, later ? 1 : 0);
    assert.match(live.text, /heartbeat/);
    assert.match(live.text, /"status":503,"code":"unavailable"/);
    assert.equal(live.text.includes('SECRET'), false);
    assert.equal(live.text.includes('retryable'), false);
    assert.equal(f.app.resourceCounts().streams, 1);
    f.state.snapshot.revision = 'newly-authorized-after-outage'; f.state.bridgeResponse = null;
    await until(() => live.text.includes('newly-authorized-after-outage'));
    assert.equal(live.ended, false, 'Recovery must use the same HTTP stream');
    assert.equal(f.state.calls.some(call => call.body), false, 'Read retries must never dispatch a write');
    live.close(); await until(() => f.app.resourceCounts().streams === 0 && f.app.resourceCounts().upstream === 0);
  });
});

test('SSE access loss after a transient outage closes immediately without broadcasting old state', { timeout: 7000 }, async t => {
  for (const status of [401, 403, 404]) await t.test(String(status), async t => {
    const f = await fixture(t, { limits: { pollRetryMaxMs: 100 } }); const device = await f.login();
    const live = await stream(f.base, device.cookie); t.after(live.close);
    await until(() => live.text.includes('snapshot'));
    f.state.status = 503;
    await until(() => live.text.includes('"status":503'));
    const before = live.text.length;
    f.state.status = status;
    await until(() => live.ended && f.app.resourceCounts().upstream === 0);
    assert.match(live.text.slice(before), new RegExp(`"status":${status}`));
    assert.equal(live.text.slice(before).includes('snapshot'), false);
    assert.equal(f.app.resourceCounts().streams, 0);
    const calls = f.state.calls.length; await delay(130); assert.equal(f.state.calls.length, calls);
    assert.equal((await f.request(`/api/guilds/${guildId}/events`, { headers: { Cookie: device.cookie } })).status, status);
  });
});

test('Overlapping device SSE polls share only pending reads; disconnect does not cancel another device or a fresh GET', { timeout: 5000 }, async t => {
  const f = await fixture(t); const first = await f.login(); const second = await f.login();
  const a = await stream(f.base, first.cookie); const b = await stream(f.base, second.cookie);
  t.after(a.close); t.after(b.close);
  await until(() => a.text.includes('snapshot') && b.text.includes('snapshot'));
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  let verifying = 0;
  f.state.beforeReply = async call => { if (call.path === `/v1/guilds/${guildId}`) { verifying++; await held; } };
  await until(() => verifying === 1);
  await delay(90);
  assert.equal(verifying, 1, 'Overlapping device polls should perform one trusted verification');
  assert.equal(f.app.resourceCounts().upstream, 1);
  const fresh = f.request(`/api/guilds/${guildId}`, { headers: { Cookie: second.cookie } }); fresh.catch(() => {});
  await until(() => verifying === 2);
  assert.equal(f.app.resourceCounts().upstream, 2, 'A deliberate fresh GET must not join an older SSE verification');
  a.close(); await until(() => f.app.resourceCounts().streams === 1);
  assert.equal(f.app.resourceCounts().upstream, 2, 'Disconnecting one subscriber must preserve the other reads');
  f.state.snapshot.revision = 'device-recovered'; release();
  assert.equal((await fresh).status, 200);
  await until(() => b.text.includes('device-recovered'));
  await until(() => verifying >= 3);
  assert.equal(a.text.includes('device-recovered'), false);
  b.close(); await until(() => f.app.resourceCounts().streams === 0 && f.app.resourceCounts().upstream === 0);
});

test('SSE heartbeats and expiry remain independent of a slow fresh permission read', { timeout: 5000 }, async t => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now }); const device = await f.login();
  const live = await stream(f.base, device.cookie); t.after(live.close);
  await until(() => live.text.includes('snapshot'));
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(release);
  let verifying = false;
  f.state.beforeReply = async call => { if (call.path === `/v1/guilds/${guildId}`) { verifying = true; await held; } };
  await until(() => verifying && f.app.resourceCounts().upstream === 1);
  const before = live.text; const calls = f.state.calls.length;
  await delay(160);
  assert.ok((live.text.slice(before.length).match(/heartbeat/g) || []).length >= 3, 'Slow authorization must not stall transport heartbeats');
  assert.equal(live.text.slice(before.length).includes('snapshot'), false, 'A heartbeat does not authorize state');
  assert.equal(f.state.calls.length, calls, 'A slow poll must not overlap another poll');
  now += LIMITS.sessionMs + 1;
  await until(() => live.ended && f.app.resourceCounts().upstream === 0);
  assert.match(live.text, /unauthenticated/);
  assert.equal(f.app.resourceCounts().streams, 0);
});

test('Authenticated SSE survives real deadlines and the 30-second HTTP timeout with automatic fresh recovery', { timeout: 45_000 }, async t => {
  const f = await fixture(t, { limits: { pollMs: LIMITS.pollMs, heartbeatMs: LIMITS.heartbeatMs,
    pollRetryMaxMs: LIMITS.pollRetryMaxMs } });
  const device = await f.login(); const live = await stream(f.base, device.cookie); t.after(live.close);
  await until(() => live.text.includes('snapshot'));
  let slow = false;
  f.state.beforeReply = async call => {
    if (call.path === `/v1/guilds/${guildId}` && !slow) { slow = true; await delay(LIMITS.upstreamMs + 1000); }
  };
  await until(() => live.text.includes('event:error'), 16_000);
  assert.match(live.text, /"status":503/);
  assert.equal(live.ended, false);
  const before = live.text.length;
  f.state.snapshot.revision = 'authorized-after-timeout';
  await until(() => live.text.slice(before).includes('authorized-after-timeout'), 9000);
  await delay(16_000);
  assert.equal(live.ended, false, 'One authenticated HTTP stream must stay open beyond 30 seconds');
  assert.ok((live.text.match(/heartbeat/g) || []).length >= 3);
  assert.ok((live.text.match(/authorized-after-timeout/g) || []).length >= 5);
  assert.equal(f.state.calls.some(call => call.body), false);
  assert.equal(f.app.resourceCounts().streams, 1);
  live.close(); await until(() => f.app.resourceCounts().streams === 0 && f.app.resourceCounts().upstream === 0);
});

test('SSE disconnect cancels an in-flight poll and releases capacity', { timeout: 5000 }, async t => {
  const f = await fixture(t); const device = await f.login();
  const cancelled = await stream(f.base, device.cookie); t.after(cancelled.close);
  await until(() => cancelled.text.includes('snapshot'));
  f.state.delayMs = 200;
  await until(() => f.app.resourceCounts().upstream === 1);
  cancelled.close();
  await until(() => f.app.resourceCounts().upstream === 0 && f.app.resourceCounts().streams === 0);
  await until(() => f.state.disconnected >= 1);
  const count = f.state.calls.length; await delay(250); assert.equal(f.state.calls.length, count);
});

test('Shared read transport isolates trusted actors and guilds and never retains completed policy results', { timeout: 5000 }, async t => {
  const f = await fixture(t); const transport = new Transport(f.config, LIMITS); t.after(() => transport.close());
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  f.state.beforeReply = async () => { await held; };
  const reads = [
    transport.bridge(`/v1/guilds/${guildId}`, actorId, { shareRead: true }),
    transport.bridge(`/v1/guilds/${guildId}`, actorId, { shareRead: true }),
    transport.bridge(`/v1/guilds/${guildId}`, '456789012345678901', { shareRead: true }),
    transport.bridge('/v1/guilds/567890123456789012', actorId, { shareRead: true }),
  ];
  const completed = Promise.all(reads); completed.catch(() => {});
  await until(() => f.state.calls.length === 3);
  assert.equal(transport.active, 3);
  assert.equal(f.state.calls.filter(call => call.params.get('actorId') === actorId).length, 2);
  release(); await completed;
  assert.equal(transport.sharedReads.size, 0);
  f.state.status = 403;
  await assert.rejects(transport.bridge(`/v1/guilds/${guildId}`, actorId, { shareRead: true }), error => error.status === 403);
  assert.equal(f.state.calls.length, 4, 'Completed authorization must not be reused after permissions change');
});

test('Shared read transport cancels after its last subscriber leaves and keeps the original bounded deadline', { timeout: 5000 }, async t => {
  const f = await fixture(t); const transport = new Transport(f.config, { ...LIMITS, upstreamMs: 300 }); t.after(() => transport.close());
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  f.state.beforeReply = async () => { await held; };
  const a = new AbortController(); const b = new AbortController();
  const first = transport.bridge(`/v1/guilds/${guildId}`, actorId, { shareRead: true, signal: a.signal });
  const second = transport.bridge(`/v1/guilds/${guildId}`, actorId, { shareRead: true, signal: b.signal });
  first.catch(() => {}); second.catch(() => {});
  await until(() => f.state.calls.length === 1);
  a.abort(); await assert.rejects(first, error => error.status === 503);
  assert.equal(transport.active, 1);
  b.abort(); await assert.rejects(second, error => error.status === 503);
  await until(() => transport.active === 0 && transport.sharedReads.size === 0 && f.state.disconnected >= 1);
  const original = transport.bridge(`/v1/guilds/${guildId}`, actorId, { shareRead: true }); original.catch(() => {});
  await until(() => f.state.calls.length === 2);
  await delay(200);
  const joinedAt = Date.now();
  const late = transport.bridge(`/v1/guilds/${guildId}`, actorId, { shareRead: true }); late.catch(() => {});
  await Promise.all([assert.rejects(original, error => error.status === 503), assert.rejects(late, error => error.status === 503)]);
  assert.ok(Date.now() - joinedAt < 250, 'A late subscriber must not reset the original 300ms deadline');
  assert.equal(f.state.calls.length, 2);
  assert.equal(transport.active, 0); assert.equal(transport.sharedReads.size, 0);
});

test('An expired session during upstream authorization cannot return protected data', { timeout: 5000 }, async t => {
  let now = Date.now(); const f = await fixture(t, { now: () => now }); const device = await f.login();
  f.state.delayMs = 100;
  const pending = f.request('/api/bootstrap', { headers: { Cookie: device.cookie } });
  await until(() => f.app.resourceCounts().upstream === 1); now += LIMITS.sessionMs + 1;
  const response = await pending; assert.equal(response.status, 401); assert.equal(response.text.includes('viewer'), false);
});

test('OAuth/session capacities fail safely without evicting live sessions, and OAuth expiry releases capacity', { timeout: 5000 }, async t => {
  let now = Date.now(); const f = await fixture(t, { now: () => now, limits: { sessions: 1, pendingOAuth: 1 } });
  const pending = await f.begin();
  assert.equal((await f.request('/auth/discord')).status, 429);
  now += LIMITS.oauthMs + 1;
  const device = await f.login();
  const additional = await f.begin();
  assert.equal((await f.request(`/auth/discord/callback?code=valid-code&state=${additional.state}`, { headers: { Cookie: additional.cookie } })).status, 429);
  assert.equal((await f.request('/api/bootstrap', { headers: { Cookie: device.cookie } })).status, 200);
  assert.equal((await f.request(`/auth/discord/callback?code=valid-code&state=${pending.state}`, { headers: { Cookie: pending.cookie } })).status, 400);
  const rotated = await f.login(device.cookie); assert.notEqual(rotated.cookie, device.cookie);
});

test('Chunked oversized and slow bodies are bounded; unrelated routes reject request bodies', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { requestMs: 75 } }); const device = await f.login();
  const route = `/api/guilds/${guildId}/commands`;
  const headers = { Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf, 'Content-Type': 'application/json' };
  assert.equal((await f.request(route, { method: 'POST', headers: { ...headers, 'Transfer-Encoding': 'chunked' }, body: 'x'.repeat(LIMITS.bodyBytes + 1) })).status, 400);
  assert.equal((await f.request('/health', { method: 'GET', headers: { 'Content-Length': 1 }, body: 'x' })).status, 400);
  assert.equal((await f.request('/auth/logout', { method: 'POST', headers, body: '{}' })).status, 400);
  const before = f.state.calls.length;
  const slow = await new Promise((resolve, reject) => {
    const url = new URL(f.base);
    const req = http.request({ hostname: url.hostname, port: url.port, path: route, method: 'POST',
      headers: { ...headers, 'Content-Length': 100 }, agent: false }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); t.after(() => req.destroy()); req.write('{');
  });
  assert.equal(slow, 400); assert.equal(f.state.calls.length, before);
  assert.equal(f.app.resourceCounts().requests, 0);
});

test('Inbound admission is capped independently of upstream capacity', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { requests: 1 } }); const device = await f.login();
  f.state.delayMs = 100;
  const first = f.request('/api/bootstrap', { headers: { Cookie: device.cookie } });
  await until(() => f.app.resourceCounts().requests === 1);
  assert.equal((await f.request('/health')).status, 429);
  assert.equal((await first).status, 200); assert.equal(f.app.resourceCounts().requests, 0);
});

test('Security regression: logout, rotation and expiry during a partial command prevent bridge dispatch', { timeout: 7000 }, async t => {
  for (const revocation of ['logout', 'rotation', 'expiry']) await t.test(revocation, async t => {
    let now = Date.now(); const f = await fixture(t, { now: () => now }); const device = await f.login();
    const partial = partialCommand(f, device); t.after(() => partial.req.destroy());
    await until(() => f.app.resourceCounts().commandReaders === 1);
    if (revocation === 'logout') {
      const logout = await f.request('/auth/logout', { method: 'POST', headers: {
        Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf } });
      assert.equal(logout.status, 200);
    } else if (revocation === 'rotation') await f.login(device.cookie);
    else now += LIMITS.sessionMs + 1;
    assert.equal((await f.request('/api/bootstrap', { headers: { Cookie: device.cookie } })).status, 401);
    partial.finish(); assert.equal(await partial.completed, 401);
    assert.equal(f.state.calls.filter(call => call.path.endsWith('/commands')).length, 0);
    assert.equal(f.app.resourceCounts().commandReaders, 0);
  });
});

test('Security regression: saturated lookup slots reserve one bounded upstream slot for authenticated Stop', { timeout: 5000 }, async t => {
  const f = await fixture(t); const device = await f.login();
  let releaseSearch; let releaseStop;
  const searchesHeld = new Promise(resolve => { releaseSearch = resolve; });
  const stopHeld = new Promise(resolve => { releaseStop = resolve; });
  t.after(() => { releaseSearch(); releaseStop(); });
  f.state.beforeReply = async call => {
    if (call.path.endsWith('/search')) await searchesHeld;
    if (call.body?.command === 'stop') await stopHeld;
  };
  const searches = Promise.all(Array.from({ length: LIMITS.upstream - LIMITS.stopUpstream }, (_, i) =>
    f.request(`/api/guilds/${guildId}/search?query=held-${i}`, { headers: { Cookie: device.cookie } })));
  searches.catch(() => {});
  await until(() => f.app.resourceCounts().ordinaryUpstream === 7);
  assert.equal((await f.request(`/api/guilds/${guildId}/search?query=extra`, { headers: { Cookie: device.cookie } })).status, 429);
  const headers = { Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf, 'Content-Type': 'application/json' };
  const stop = f.request(`/api/guilds/${guildId}/commands`, { method: 'POST', headers, body: '{"command":"stop"}' });
  stop.catch(() => {});
  await until(() => f.state.calls.some(call => call.body?.command === 'stop'));
  assert.equal(f.app.resourceCounts().upstream, LIMITS.upstream);
  assert.equal(f.app.resourceCounts().stopUpstream, 1);
  const calls = f.state.calls.length;
  assert.equal((await f.request(`/api/guilds/${guildId}/commands`, { method: 'POST', headers, body: '{"command":"stop"}' })).status, 429);
  assert.equal((await f.request(`/api/guilds/${guildId}/commands`, { method: 'POST', headers, body: '{"command":"pause"}' })).status, 429);
  assert.equal(f.state.calls.length, calls);
  releaseStop(); assert.equal((await stop).status, 200);
  assert.equal(f.app.resourceCounts().ordinaryUpstream, 7);
  releaseSearch(); assert.ok((await searches).every(response => response.status === 200));
  assert.equal(f.app.resourceCounts().upstream, 0);
});

test('Security regression: full ordinary inbound handlers and slow uploads cannot block Stop admission', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { requests: 2, commandReaders: 2, upstream: 4 } }); const device = await f.login();
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(release);
  f.state.beforeReply = async call => { if (call.path.endsWith('/search')) await held; };
  const searches = Promise.all([1, 2].map(i => f.request(`/api/guilds/${guildId}/search?query=held-${i}`, { headers: { Cookie: device.cookie } })));
  searches.catch(() => {});
  await until(() => f.app.resourceCounts().ordinaryRequests === 2);
  const uploads = [];
  for (let i = 0; i < 2; i++) {
    const partial = partialCommand(f, device, { command: 'play', options: { query: `slow-${i}` } });
    uploads.push(partial); t.after(() => partial.req.destroy());
    await until(() => f.app.resourceCounts().commandReaders === i + 1);
  }
  const headers = { Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf, 'Content-Type': 'application/json' };
  assert.equal((await f.request(`/api/guilds/${guildId}/commands`, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': 'wrong' }, body: '{"command":"stop"}' })).status, 403);
  assert.equal(f.app.resourceCounts().commandReaders, 2);
  assert.equal((await f.request(`/api/guilds/${guildId}/commands`, { method: 'POST', headers, body: '{"command":"stop"}' })).status, 200);
  assert.equal(await uploads[0].completed, 429); // Oldest incomplete upload is evicted before any dispatch.
  assert.equal(f.app.resourceCounts().commandReaders, 1);
  uploads[1].finish(); assert.equal(await uploads[1].completed, 429); // Ordinary capacity is still occupied.
  assert.deepEqual(f.state.calls.filter(call => call.body).map(call => call.body.command), ['stop']);
  release(); assert.ok((await searches).every(response => response.status === 200));
  assert.equal(f.app.resourceCounts().requests, 0);
});

test('Security regression: anonymous start and aggregate peer limits do not consume valid callback or logout budgets', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { anonymousRequests: 32 } }); const first = await f.login(); const second = await f.login(); const pending = await f.begin();
  for (let i = 0; i < 17; i++) assert.equal((await f.request('/auth/discord')).status, 302);
  assert.equal((await f.request('/auth/discord', { headers: { 'X-Forwarded-For': '203.0.113.10', Forwarded: 'for=203.0.113.10' } })).status, 429);
  // Invalid state never reaches Discord and cannot consume another browser's state.
  const tokenCalls = f.state.tokenCalls.length;
  assert.equal((await f.request('/auth/discord/callback?code=a&state=wrong')).status, 400);
  assert.equal(f.state.tokenCalls.length, tokenCalls);
  // Saturate the separate aggregate anonymous peer bound, not just OAuth starts.
  for (let i = 0; i < 12; i++) await f.request('/missing-asset.js');
  assert.equal((await f.request('/missing-asset.js')).status, 429);
  const callback = await f.request(`/auth/discord/callback?code=valid-code&state=${pending.state}`, { headers: { Cookie: pending.cookie } });
  assert.equal(callback.status, 302);
  assert.equal(f.state.tokenCalls.length, tokenCalls + 1);
  assert.equal((await f.request('/api/bootstrap', { headers: { Cookie: cookieValue(callback, SESSION_COOKIE) } })).status, 200);
  f.state.status = 503;
  for (const device of [first, second]) assert.equal((await f.request('/auth/logout', { method: 'POST', headers: {
    Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf } })).status, 200);
});

test('Search and command schemas match query/seek limits and revision-fenced clear, favorites and session operations', { timeout: 5000 }, async t => {
  const f = await fixture(t); const device = await f.login();
  const route = `/api/guilds/${guildId}/commands`;
  const headers = { Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf, 'Content-Type': 'application/json' };
  const send = body => f.request(route, { method: 'POST', headers, body: JSON.stringify(body) });
  const revision = { expectedRevision: 'revision-1' };
  const valid = [
    { command: 'clear', ...revision },
    { command: 'favorite', subcommand: 'add', ...revision },
    { command: 'favorite', subcommand: 'add', options: { position: 1 }, ...revision },
    { command: 'favorite', subcommand: 'add', options: { position: 500 }, ...revision },
    { command: 'replay', options: { index: 1 }, expectedHistoryId: 'history-1', ...revision },
    { command: 'session', subcommand: 'resume', ...revision },
    { command: 'session', subcommand: 'discard', ...revision },
    { command: 'play', options: { query: 'x'.repeat(200) } },
    { command: 'playnext', options: { query: 'x'.repeat(200) }, ...revision },
    ...['0:00', '1:02:03', '100:00', '999999999:59', ' 1:02 '].map(timestamp => ({ command: 'seek', options: { timestamp }, ...revision })),
  ];
  for (const command of valid) {
    assert.equal((await send(command)).status, 200, JSON.stringify(command));
    assert.deepEqual(f.state.calls.at(-1).body, { actorId, options: {}, ...command });
  }
  const before = f.state.calls.length;
  for (const command of valid.slice(0, 7)) {
    const { expectedRevision, ...withoutRevision } = command;
    assert.equal((await send(withoutRevision)).status, 400);
  }
  for (const position of [0, 501, 1.5, '1', null]) assert.equal((await send({ command: 'favorite', subcommand: 'add', options: { position }, ...revision })).status, 400);
  assert.equal((await send({ command: 'clear', options: { current: true }, ...revision })).status, 400);
  assert.equal((await send({ command: 'favorite', subcommand: 'add', options: { track: { id: 'forged' } }, ...revision })).status, 400);
  for (const command of ['play', 'playnext']) assert.equal((await send({ command, options: { query: 'x'.repeat(201) }, ...revision })).status, 400);
  for (const timestamp of ['1:2', '0:60', '1:60:00', '-1:00', '1:00:00:00', '9999999999:59', 'arbitrary']) {
    assert.equal((await send({ command: 'seek', options: { timestamp }, ...revision })).status, 400, timestamp);
  }
  assert.equal(f.state.calls.length, before);
  assert.equal((await f.request(`/api/guilds/${guildId}/search?query=${'x'.repeat(201)}`, { headers: { Cookie: device.cookie } })).status, 400);
  assert.equal(f.state.calls.length, before);
  assert.equal((await f.request(`/api/guilds/${guildId}/search?query=${'x'.repeat(200)}`, { headers: { Cookie: device.cookie } })).status, 200);
});

test('Library selection tokens are required, command-specific and forwarded with server-owned identity', { timeout: 5000 }, async t => {
  const f = await fixture(t); const device = await f.login();
  const route = `/api/guilds/${guildId}/commands`;
  const headers = { Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf, 'Content-Type': 'application/json' };
  const send = body => f.request(route, { method: 'POST', headers, body: JSON.stringify(body) });
  const requests = [
    { command: 'favorite', subcommand: 'play', options: { index: 2 }, expectedTrackId: 'a'.repeat(24) },
    { command: 'favorite', subcommand: 'remove', options: { index: 2 }, expectedTrackId: 'a'.repeat(24) },
    { command: 'replay', options: { index: 1 }, expectedRevision: 'revision-1', expectedHistoryId: 'selected-history-entry' },
    { command: 'mix', subcommand: 'delete', options: { name: 'night' }, expectedMixVersion: 'b'.repeat(32) },
  ];
  for (const body of requests) {
    const field = Object.keys(body).find(key => ['expectedTrackId', 'expectedHistoryId', 'expectedMixVersion'].includes(key));
    const { [field]: ignored, ...unbound } = body;
    const before = f.state.calls.length;
    assert.equal((await send(unbound)).status, 400);
    assert.equal((await send({ ...body, [field]: null })).status, 400);
    assert.equal((await send({ ...body, [field]: 'x'.repeat(41) })).status, 400);
    assert.equal(f.state.calls.length, before, 'Unbound selections must not reach the bot');
    assert.equal((await send(body)).status, 200);
    assert.deepEqual(f.state.calls.at(-1).body, { actorId, ...body });
  }
  const before = f.state.calls.length;
  assert.equal((await send({ command: 'pause', expectedTrackId: 'a'.repeat(24) })).status, 400);
  assert.equal((await send({ ...requests[1], actorId: 'another-account' })).status, 400);
  assert.equal((await send({ ...requests[2], expectedHistoryId: 'unsafe\nentry' })).status, 400);
  assert.equal(f.state.calls.length, before);
  f.state.status = 409;
  assert.equal((await send(requests[1])).status, 409);
  await delay(50);
  assert.equal(f.state.calls.length, before + 1, 'A changed selection must never replay its removal');
});

test('Command deadlines allow bounded imports past the body deadline, and timed-out writes never replay', { timeout: 5000 }, async t => {
  assert.equal(LIMITS.commandMs, 90_000);
  const f = await fixture(t, { limits: { requestMs: 50, upstreamMs: 50, commandMs: 200 } }); const device = await f.login();
  const headers = { Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf, 'Content-Type': 'application/json' };
  f.state.delayMs = 100;
  assert.equal((await f.request(`/api/guilds/${guildId}/commands`, { method: 'POST', headers, body: '{"command":"play","options":{"query":"public import"}}' })).status, 200);
  f.state.delayMs = 400;
  assert.equal((await f.request(`/api/guilds/${guildId}/commands`, { method: 'POST', headers, body: '{"command":"play","options":{"query":"timeout import"}}' })).status, 503);
  const calls = f.state.calls.filter(call => call.body?.command === 'play'); assert.equal(calls.length, 2);
  await until(() => f.app.resourceCounts().upstream === 0); await delay(250);
  assert.equal(f.state.calls.filter(call => call.body?.command === 'play').length, 2);
});

test('Security regression: saturated portal and real bot bridge still execute urgent Stop and fence a slow addition', { timeout: 7000 }, async t => {
  // Run the actual trusted policy/HTTP bridge/request lane/Stop implementation
  // against the bot's isolated Discord/Lavalink/library fixture. No live services.
  const { portalFixture, deferred } = await import('../../../tests/portal-fixtures.js');
  const { track } = await import('../../../tests/fixtures.js');
  const gate = deferred(); let lookups = 0; t.after(() => gate.resolve({ loadType: 'track', tracks: [track()] }));
  const bot = await portalFixture(t, { search: () => { lookups++; return gate.promise; }, bridge: { maxInFlight: 7 } });
  const f = await fixture(t, { botOrigin: bot.origin, botToken: bot.token, limits: { requests: 7 } });
  f.state.identity = '200'; const device = await f.login();
  const headers = { Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf, 'Content-Type': 'application/json' };
  const addition = f.request('/api/guilds/100/commands', { method: 'POST', headers, body: '{"command":"play","options":{"query":"slow addition"}}' });
  addition.catch(() => {}); await until(() => lookups === 1);
  const searches = Promise.all(Array.from({ length: 6 }, (_, i) => f.request(`/api/guilds/100/search?query=held-${i}`, { headers: { Cookie: device.cookie } })));
  searches.catch(() => {});
  await until(() => lookups === 7 && f.app.resourceCounts().ordinaryUpstream === 7 && f.app.resourceCounts().ordinaryRequests === 7);
  const stop = await f.request('/api/guilds/100/commands', { method: 'POST', headers, body: '{"command":"stop"}' });
  assert.equal(stop.status, 200, stop.text);
  assert.equal(stop.json().snapshot.session.status, 'idle');
  assert.equal(bot.manager.getPlayer('100'), undefined);
  assert.ok(bot.calls.includes('destroy')); assert.equal(f.app.resourceCounts().ordinaryUpstream, 7);
  const stoppedAt = bot.calls.length;
  gate.resolve({ loadType: 'track', tracks: [track()] });
  assert.ok([403, 404, 409].includes((await addition).status));
  assert.ok((await searches).every(response => response.status === 200));
  assert.equal(bot.calls.slice(stoppedAt).includes('add'), false);
  assert.equal(bot.calls.slice(stoppedAt).includes('connect'), false);
  assert.equal(bot.manager.getPlayer('100'), undefined);
  await bot.library.pending; assert.equal(bot.library.readGuild('100').session, null);
  assert.equal(f.app.resourceCounts().upstream, 0);
});

test('lyrics reads forward only the signed-in actor and accept no query', async t => {
  const f = await fixture(t); const device = await f.login();
  const read = await f.request(`/api/guilds/${guildId}/lyrics`, { headers: { Cookie: device.cookie } });
  assert.equal(read.status, 200);
  assert.equal(read.json().lyrics.lines[0].text, 'First line');
  const call = f.state.calls.findLast(item => item.path.endsWith('/lyrics'));
  assert.equal(call.path, `/v1/guilds/${guildId}/lyrics`);
  assert.deepEqual([...call.params.keys()], ['actorId']);
  assert.equal(call.params.get('actorId'), actorId);
  for (const query of ['track=1', 'actorId=1']) {
    assert.equal((await f.request(`/api/guilds/${guildId}/lyrics?${query}`, { headers: { Cookie: device.cookie } })).status, 400, query);
  }
  assert.equal((await f.request(`/api/guilds/${guildId}/lyrics`)).status, 401);

  // A song playing on this device, by its YouTube video.
  const onDevice = await f.request(`/api/guilds/${guildId}/lyrics/dX3k_QDnzHE`, { headers: { Cookie: device.cookie } });
  assert.equal(onDevice.status, 200);
  assert.equal(onDevice.json().status, 'not_found');
  const deviceCall = f.state.calls.findLast(item => item.path.endsWith('/lyrics/dX3k_QDnzHE'));
  assert.equal(deviceCall.path, `/v1/guilds/${guildId}/lyrics/dX3k_QDnzHE`);
  assert.deepEqual([...deviceCall.params.keys()], ['actorId']);
  for (const path of ['lyrics/dX3k_QDnzHE?track=1', 'lyrics/short', 'lyrics/dX3k_QDnzHE/extra']) {
    assert.notEqual((await f.request(`/api/guilds/${guildId}/${path}`, { headers: { Cookie: device.cookie } })).status, 200, path);
  }
  assert.equal((await f.request(`/api/guilds/${guildId}/lyrics/dX3k_QDnzHE`)).status, 401);
});

test('stats reads forward only a supported window, and clearing request stats needs CSRF and same origin', async t => {
  const f = await fixture(t); const device = await f.login();
  const read = await f.request(`/api/guilds/${guildId}/stats?window=90d`, { headers: { Cookie: device.cookie } });
  assert.equal(read.status, 200);
  assert.equal(read.json().personal.window, '90d');
  const call = f.state.calls.findLast(item => item.path.endsWith('/stats'));
  assert.equal(call.path, `/v1/guilds/${guildId}/stats`);
  assert.deepEqual([...call.params.keys()].sort(), ['actorId', 'window']);
  assert.equal(call.params.get('actorId'), actorId);
  for (const query of ['window=forever', 'window=30d&window=7d', 'actorId=1', 'other=1']) {
    assert.equal((await f.request(`/api/guilds/${guildId}/stats?${query}`, { headers: { Cookie: device.cookie } })).status, 400, query);
  }
  assert.equal((await f.request(`/api/guilds/${guildId}/stats`)).status, 401);

  const path = '/api/stats/requests/clear';
  const calls = () => f.state.calls.filter(item => item.path === '/v1/stats/requests/clear').length;
  assert.equal((await f.request(path, { method: 'POST', headers: { Cookie: device.cookie, Origin: origin } })).status, 403, 'CSRF required');
  assert.equal((await f.request(path, { method: 'POST', headers: { Cookie: device.cookie, 'X-CSRF-Token': device.csrf } })).status, 403, 'Origin required');
  assert.equal((await f.request(path, { headers: { Cookie: device.cookie } })).status, 404, 'GET does not clear');
  assert.equal(calls(), 0);
  const cleared = await f.request(path, { method: 'POST', headers: { Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.json(), { ok: true, cleared: 2 });
  const forwarded = f.state.calls.findLast(item => item.path === '/v1/stats/requests/clear');
  assert.equal(forwarded.params.get('actorId'), actorId);
  assert.equal(forwarded.body, null);
});

test('recap reads forward only a recap window and the trusted actor', async t => {
  const f = await fixture(t); const device = await f.login();
  const read = await f.request(`/api/guilds/${guildId}/recap?window=7d`, { headers: { Cookie: device.cookie } });
  assert.equal(read.status, 200);
  assert.equal(read.json().window, '7d');
  const call = f.state.calls.findLast(item => item.path.endsWith('/recap'));
  assert.equal(call.path, `/v1/guilds/${guildId}/recap`);
  assert.deepEqual([...call.params.keys()].sort(), ['actorId', 'window']);
  assert.equal(call.params.get('actorId'), actorId);
  assert.equal((await f.request(`/api/guilds/${guildId}/recap`, { headers: { Cookie: device.cookie } })).status, 200, 'window is optional');
  assert.deepEqual([...f.state.calls.findLast(item => item.path.endsWith('/recap')).params.keys()], ['actorId']);
  // All time stays on the stats endpoint; a recap covers at most a year of retention.
  for (const query of ['window=all', 'window=forever', 'window=30d&window=7d', 'actorId=1', 'other=1']) {
    assert.equal((await f.request(`/api/guilds/${guildId}/recap?${query}`, { headers: { Cookie: device.cookie } })).status, 400, query);
  }
  assert.equal((await f.request(`/api/guilds/${guildId}/recap`)).status, 401);
  assert.equal((await f.request(`/api/guilds/${guildId}/recap`, { method: 'POST', headers: { Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf } })).status, 404);
});

test('top commands accept only their published lists and options', async t => {
  const f = await fixture(t); const device = await f.login();
  for (const command of [{ command: 'top', subcommand: 'play', options: { list: 'on-repeat', shuffle: true } }, { command: 'top', subcommand: 'show', options: { list: 'forgotten-gems', page: 2 } }]) {
    assert.equal((await sendCommand(f, device, command)).status, 200, JSON.stringify(command));
  }
  for (const command of [{ command: 'top', subcommand: 'play', options: { list: 'everything' } }, { command: 'top', subcommand: 'play', options: { shuffle: 'yes' } }, { command: 'top', subcommand: 'show', options: { page: 4 } }, { command: 'top' }]) {
    assert.equal((await sendCommand(f, device, command)).status, 400, JSON.stringify(command));
  }
});

test('personal playlist and session mix commands accept only their published options', async t => {
  const f = await fixture(t); const device = await f.login();
  const revision = 'a'.repeat(32);
  for (const command of [
    { command: 'mymix', subcommand: 'play', options: { playlist: 'mix', shuffle: true } },
    { command: 'mymix', subcommand: 'play', options: { playlist: 'artist', artist: 'Nova' } },
    { command: 'mymix', subcommand: 'show', options: { playlist: 'top', window: '365d', page: 3 } },
    { command: 'mix', subcommand: 'save', options: { name: 'friday', session: true }, expectedRevision: revision },
  ]) assert.equal((await sendCommand(f, device, command)).status, 200, JSON.stringify(command));
  for (const command of [
    { command: 'mymix', subcommand: 'play', options: { playlist: 'server' } },
    { command: 'mymix', subcommand: 'play', options: { window: '2d' } },
    { command: 'mymix', subcommand: 'play', options: { artist: 'x'.repeat(101) } },
    { command: 'mymix', subcommand: 'show', options: { page: 4 } },
    { command: 'mymix' },
    { command: 'mix', subcommand: 'save', options: { name: 'friday', session: 'yes' }, expectedRevision: revision },
    { command: 'mix', subcommand: 'save', options: { name: 'friday', session: true } },
  ]) assert.equal((await sendCommand(f, device, command)).status, 400, JSON.stringify(command));
});

test('bootstrap forwards the voice server only when it is a listed server', async t => {
  const f = await fixture(t); const { cookie } = await f.login();
  const voiceGuild = async value => { f.state.voiceGuildId = value; return (await f.request('/api/bootstrap', { headers: { Cookie: cookie } })).json().voiceGuildId; };
  assert.equal(await voiceGuild(guildId), guildId);
  assert.equal(await voiceGuild('567890123456789012'), null);
  assert.equal(await voiceGuild(undefined), null);
});

test('bootstrap offers only this application’s Discord install link', async t => {
  const f = await fixture(t); const { cookie } = await f.login();
  const invite = async value => { f.state.inviteUrl = value; return (await f.request('/api/bootstrap', { headers: { Cookie: cookie } })).json().inviteUrl; };
  const own = 'https://discord.com/oauth2/authorize?client_id=345678901234567890&scope=bot+applications.commands&permissions=1&integration_type=0';
  assert.equal(await invite(own), own);
  assert.equal(await invite(undefined), null);
  assert.equal(await invite(own.replace('345678901234567890', '999999999999999999')), null);
  assert.equal(await invite(own.replace('discord.com', 'discord.example')), null);
  assert.equal(await invite(`${own}&x=${'a'.repeat(600)}`), null);
});

test('transfer forwards a bounded list of public song links and nothing else', async () => {
  const { validateCommand } = await import('../src/commands.js');
  const options = { position: 42_000, paused: false, volume: 60, repeat: 'queue' };
  const tracks = ['https://www.youtube.com/watch?v=abcdefghijk', 'https://soundcloud.com/artist/song'];
  assert.deepEqual(validateCommand({ command: 'transfer', options, tracks }), { command: 'transfer', options, tracks });
  for (const bad of [[], ['http://example.com/song'], ['https://example.com/a b'], ['x'], [42], Array(101).fill(tracks[0]), 'https://example.com']) {
    assert.throws(() => validateCommand({ command: 'transfer', options, tracks: bad }), undefined, JSON.stringify(bad));
  }
  assert.throws(() => validateCommand({ command: 'transfer', options }));
  assert.throws(() => validateCommand({ command: 'play', options: { query: 'song' }, tracks }));
  assert.throws(() => validateCommand({ command: 'transfer', options: { ...options, position: -1 }, tracks }));
  assert.throws(() => validateCommand({ command: 'transfer', options: { ...options, repeat: 'all' }, tracks }));
});

test('sleep commands accept 1-720 minutes and their hyphenated subcommand', async () => {
  const { validateCommand } = await import('../src/commands.js');
  for (const minutes of [1, 720]) assert.deepEqual(validateCommand({ command: 'sleep', subcommand: 'in', options: { minutes } }), { command: 'sleep', subcommand: 'in', options: { minutes } });
  for (const minutes of [0, 721, 1.5, '30', null]) assert.throws(() => validateCommand({ command: 'sleep', subcommand: 'in', options: { minutes } }), undefined, String(minutes));
  assert.throws(() => validateCommand({ command: 'sleep', subcommand: 'in' }));
  for (const subcommand of ['after-track', 'cancel', 'show']) assert.deepEqual(validateCommand({ command: 'sleep', subcommand }), { command: 'sleep', subcommand, options: {} });
  for (const subcommand of ['after-', '-track', 'after--track', 'After-track', 'after_track']) assert.throws(() => validateCommand({ command: 'sleep', subcommand }), undefined, subcommand);
});

test('device audio passes byte ranges through and nothing but audio', { timeout: 5000 }, async t => {
  const f = await fixture(t); const device = await f.login(); const headers = { Cookie: device.cookie };
  const route = `/api/guilds/${guildId}/audio/abcdefghijk`;
  f.state.bridgeResponse = (res, call) => {
    if (call.range === 'bytes=2-5') { res.writeHead(206, { 'Content-Type': 'audio/mp4', 'Content-Length': 4, 'Content-Range': 'bytes 2-5/10', 'X-Private': 'secret' }); res.end('2345'); }
    else { res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': 10, 'Set-Cookie': 'leak=1' }); res.end('0123456789'); }
  };
  const whole = await f.request(route, { headers });
  assert.equal(whole.status, 200); assert.equal(whole.text, '0123456789');
  assert.equal(whole.headers['content-type'], 'audio/mp4'); assert.equal(whole.headers['accept-ranges'], 'bytes');
  assert.equal(whole.headers['set-cookie'], undefined); assert.equal(whole.headers['cache-control'], 'no-store');
  const call = f.state.calls.at(-1);
  assert.equal(call.path, `/v1/guilds/${guildId}/audio/abcdefghijk`); assert.equal(call.params.get('actorId'), actorId);
  assert.equal(call.authorization, `Bearer ${secret}`);
  const part = await f.request(route, { headers: { ...headers, Range: 'bytes=2-5' } });
  assert.equal(part.status, 206); assert.equal(part.text, '2345'); assert.equal(part.headers['content-range'], 'bytes 2-5/10');
  assert.equal(part.headers['x-private'], undefined); assert.equal(f.state.calls.at(-1).range, 'bytes=2-5');

  // A JSON or oversized answer is never passed to the browser.
  f.state.bridgeResponse = res => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"private":true}'); };
  assert.equal((await f.request(route, { headers })).status, 503);
  f.state.bridgeResponse = res => { res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': 41 * 1024 * 1024 }); res.end(); };
  assert.equal((await f.request(route, { headers })).status, 503);
  f.state.bridgeResponse = res => reply(res, 404, { error: { code: 'audio_unavailable', message: 'SECRET detail' } });
  const missing = await f.request(route, { headers });
  assert.equal(missing.status, 404); assert.doesNotMatch(missing.text, /SECRET/);

  assert.equal((await f.request(route, { headers: { ...headers, Range: 'bytes=0-1,4-5' } })).status, 400);
  assert.equal((await f.request(`/api/guilds/${guildId}/audio/short`, { headers })).status, 404);
  assert.equal((await f.request(route)).status, 401);
});

test('device audio streams a song still arriving and cuts off anything past the cap', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { audioBytes: 12 } }); const device = await f.login(); const headers = { Cookie: device.cookie };
  const route = `/api/guilds/${guildId}/audio/abcdefghijk`;
  f.state.bridgeResponse = res => { res.writeHead(200, { 'Content-Type': 'audio/ogg' }); res.write('OggS'); setTimeout(() => res.end('-rest'), 20); };
  const streamed = await f.request(route, { headers });
  assert.equal(streamed.status, 200); assert.equal(streamed.text, 'OggS-rest');
  assert.equal(streamed.headers['content-type'], 'audio/ogg'); assert.equal(streamed.headers['content-length'], undefined);
  f.state.bridgeResponse = res => { res.writeHead(200, { 'Content-Type': 'audio/ogg' }); res.write('0123456789'); setTimeout(() => res.end('0123456789'), 20); };
  await assert.rejects(f.request(route, { headers }));
});

test('playlist imports accept a public link, an optional preview id, and pass through only a bounded preview', async t => {
  const f = await fixture(t); const device = await f.login();
  const link = 'https://music.youtube.com/playlist?list=PL1';
  const id = 'b'.repeat(32);
  const preview = { id, target: 'mix', name: 'road trip', title: 'Road trip', found: 3, toAdd: 2, duplicates: 1, unmatched: 0, overLimit: 0, limit: 100,
    notes: [], tracks: [{ title: 'Open Road', author: 'Northline' }, { title: 'Mile Marker', author: 'Solara' }] };
  f.state.commandExtra = { preview: { ...preview, encoded: 'never-forward' } };
  const shown = await sendCommand(f, device, { command: 'mix', subcommand: 'import', options: { name: 'road trip', link } });
  assert.equal(shown.status, 200, shown.text);
  assert.deepEqual(shown.json().preview, preview);
  f.state.commandExtra = {};
  for (const command of [{ command: 'favorite', subcommand: 'import', options: { link }, expectedImportId: id }, { command: 'favorite', subcommand: 'import', options: { link } }]) {
    assert.equal((await sendCommand(f, device, command)).status, 200, JSON.stringify(command));
    assert.deepEqual(f.state.calls.findLast(call => call.path.endsWith('/commands')).body, { actorId, ...command });
  }
  for (const command of [{ command: 'favorite', subcommand: 'import', options: { link: 'http://example.com/list' } },
    { command: 'favorite', subcommand: 'import', options: { link }, expectedImportId: 'nope' },
    { command: 'favorite', subcommand: 'list', expectedImportId: id }, { command: 'mix', subcommand: 'import', options: { link } }]) {
    assert.equal((await sendCommand(f, device, command)).status, 400, JSON.stringify(command));
  }
  f.state.commandExtra = { preview: { ...preview, tracks: Array.from({ length: 101 }, () => preview.tracks[0]), toAdd: 101 } };
  assert.equal((await sendCommand(f, device, { command: 'favorite', subcommand: 'import', options: { link } })).status, 503, 'an oversized preview is refused');
});

const unchangedEvents = live => [...live.text.matchAll(/event:unchanged\ndata:(.*)\n\n/g)].map(match => JSON.parse(match[1]));
const botInstance = '11111111-2222-4333-8444-555555555555';
// A bridge whose snapshots carry a fresh ordering stamp on every read, like the bot's.
function orderedBridge(f, view) {
  let sequence = 0;
  f.state.bridgeResponse = (res, call) => {
    const data = { ...structuredClone(typeof view === 'function' ? view() : view), ordering: { instanceId: botInstance, sequence: ++sequence } };
    reply(res, 200, call.body ? { ok: true, message: 'Updated.', snapshot: data } : data);
  };
}

test('Quiet streams send a snapshot only when what this viewer sees changes', { timeout: 7000 }, async t => {
  const f = await fixture(t, { limits: { pollMs: 25 } }); const device = await f.login();
  const view = snapshot(); orderedBridge(f, view);
  const live = await stream(f.base, device.cookie, {}, guildId, '?protocol=2'); t.after(live.close);
  await until(() => unchangedEvents(live).length >= 3);
  assert.equal(streamSnapshots(live).length, 1, 'identical reads send no snapshot');
  const renewals = unchangedEvents(live);
  assert.ok(renewals.every(event => event.revision === 'revision-1' && event.ordering.instanceId === botInstance));
  assert.ok(renewals.every((event, index) => index === 0 || event.ordering.sequence > renewals[index - 1].ordering.sequence));
  assert.deepEqual(Object.keys(renewals[0]).sort(), ['ordering', 'revision'], 'a renewal carries no protected state');
  const changes = [
    ['a viewer-only capability', () => { view.session.canControl = false; }],
    ['the shared revision', () => { view.revision = 'revision-2'; }],
    ['a position jump', () => { view.session.positionMs = 9000; }],
  ];
  for (const [label, change] of changes) {
    const before = streamSnapshots(live).length; change();
    await until(() => streamSnapshots(live).length === before + 1);
    const count = unchangedEvents(live).length; await until(() => unchangedEvents(live).length >= count + 2);
    assert.equal(streamSnapshots(live).length, before + 1, `${label} is sent once`);
  }
  // An idle session's position stays put; small differences are not a change.
  view.session.positionMs = 9500;
  let count = unchangedEvents(live).length; await until(() => unchangedEvents(live).length >= count + 3);
  assert.equal(streamSnapshots(live).length, 4);
  assert.equal(streamSnapshots(live).at(-1).session.canControl, false);
  // A saved checkpoint's time shows only while nothing plays.
  view.savedSession = { ...view.savedSession, exists: true, savedAt: 1000, positionMs: 30_000 };
  await until(() => streamSnapshots(live).length === 5);
  view.session.status = 'paused';
  await until(() => streamSnapshots(live).length === 6);
  view.savedSession.savedAt = 2000; view.savedSession.positionMs = 60_000;
  count = unchangedEvents(live).length; await until(() => unchangedEvents(live).length >= count + 3);
  assert.equal(streamSnapshots(live).length, 6, 'a paused session hides its checkpoint time');
  view.session.status = 'idle';
  await until(() => streamSnapshots(live).length === 7);
  assert.equal(streamSnapshots(live).at(-1).savedSession.savedAt, 2000);
});

test('A playing session stays quiet while its position advances on time', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { pollMs: 25 } }); const device = await f.login();
  const began = Date.now(); const view = snapshot(); view.session.status = 'playing';
  orderedBridge(f, () => ({ ...view, session: { ...view.session, positionMs: 1000 + Date.now() - began } }));
  const live = await stream(f.base, device.cookie, {}, guildId, '?protocol=2'); t.after(live.close);
  await until(() => unchangedEvents(live).length >= 5);
  assert.equal(streamSnapshots(live).length, 1);
});

test('Pages without protocol 2 keep receiving a snapshot on every read', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { pollMs: 25 } }); const device = await f.login();
  orderedBridge(f, snapshot());
  const live = await stream(f.base, device.cookie); t.after(live.close);
  await until(() => streamSnapshots(live).length >= 4);
  assert.equal(unchangedEvents(live).length, 0);
  for (const query of ['?protocol=3', '?protocol=2&protocol=2', '?quiet=1']) {
    assert.equal((await f.request(`/api/guilds/${guildId}/events${query}`, { headers: { Cookie: device.cookie } })).status, 400, query);
  }
});

test('Quiet streams resend a full snapshot after a transient error frame', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { pollMs: 25, pollRetryMaxMs: 50 } }); const device = await f.login();
  const view = snapshot(); orderedBridge(f, view); const ordered = f.state.bridgeResponse;
  const live = await stream(f.base, device.cookie, {}, guildId, '?protocol=2'); t.after(live.close);
  await until(() => unchangedEvents(live).length >= 1);
  f.state.bridgeResponse = res => reply(res, 503, { error: { code: 'unavailable' } });
  await until(() => live.text.includes('event:error'));
  f.state.bridgeResponse = ordered;
  await until(() => streamSnapshots(live).length === 2);
  assert.equal(streamSnapshots(live)[1].revision, 'revision-1', 'only a snapshot can restore freshness after an error');
});

// Models the bot: one feed entry per change, found a little after the change
// (the old bot's scan; Lavalink events), the feed position each snapshot read
// began at, and a read that takes a moment for its Discord authorization round.
function cursorBridge(f, { cursors, readMs = 30, feedMs = 60 }) {
  let sequence = 0; let revision = 1; let hold = null; const entries = []; const held = []; const reads = [];
  const send = (res, data, headers = {}) => {
    const body = JSON.stringify(data);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }); res.end(body);
  };
  const header = position => (cursors ? { 'X-Change-Cursor': `${botInstance}:${position}` } : {});
  const answer = (res, after) => {
    const latest = new Map(); for (const entry of entries) if (entry.sequence > after) latest.set(entry.guildId, entry.sequence);
    send(res, { instanceId: botInstance, sequence, reset: false, guildIds: [...latest.keys()], sequences: [...latest.values()] });
  };
  f.state.changes = (res, call) => {
    const after = Number(call.params.get('after'));
    if (call.params.get('instance') !== botInstance) { send(res, { instanceId: botInstance, sequence, reset: true, guildIds: [] }); return; }
    if (sequence > after) answer(res, after); else held.push({ res, after });
  };
  f.state.beforeReply = async call => {
    if (call.body) return;
    call.cursor = sequence; reads.push(call.params.get('actorId'));
    const wait = hold; hold = null;
    await (wait || delay(readMs));
  };
  f.state.bridgeResponse = (res, call) => {
    const data = { ...snapshot(), revision: `revision-${revision}`, ordering: { instanceId: botInstance, sequence: 1000 + reads.length + sequence } };
    if (!call.body) { send(res, data, header(call.cursor)); return; }
    revision++; entries.push({ sequence: ++sequence, guildId });
    send(res, { ok: true, message: 'Updated.', snapshot: { ...data, revision: `revision-${revision}` } }, header(sequence));
    setTimeout(() => { for (const poll of held.splice(0)) answer(poll.res, poll.after); }, feedMs);
  };
  return { reads, held: () => held.length, hold: gate => { hold = gate; } };
}

test('One command reaches each stream as one fresh read and one frame', { timeout: 10_000 }, async t => {
  const results = {};
  for (const cursors of [false, true]) {
    await t.test(cursors ? 'with change cursors' : 'without change cursors', async t => {
      const f = await fixture(t, { changeFeed: true, limits: { pollMs: 10_000, pollFeedMs: 10_000 } });
      const acting = await f.login(); f.state.identity = '456789012345678901'; const viewing = await f.login();
      const bot = cursorBridge(f, { cursors });
      await until(() => bot.held() === 1 && f.app.resourceCounts().feedLive);
      const a = await stream(f.base, acting.cookie, {}, guildId, '?protocol=2'); const b = await stream(f.base, viewing.cookie, {}, guildId, '?protocol=2');
      for (const live of [a, b]) t.after(live.close);
      await until(() => streamSnapshots(a).length === 1 && streamSnapshots(b).length === 1);
      await delay(100); const before = bot.reads.length;
      assert.equal((await sendCommand(f, acting)).status, 200);
      await until(() => streamSnapshots(a).length === 2 && streamSnapshots(b).length === 2);
      await delay(300);
      results[cursors] = { reads: bot.reads.length - before, snapshots: streamSnapshots(a).length + streamSnapshots(b).length - 2,
        unchanged: unchangedEvents(a).length + unchangedEvents(b).length };
      t.diagnostic(`${cursors ? 'with' : 'without'} cursors, 2 streams: ${JSON.stringify(results[cursors])}`);
      assert.ok(streamSnapshots(a).at(-1).revision === 'revision-2' && streamSnapshots(b).at(-1).revision === 'revision-2');
    });
  }
  assert.equal(results.false.reads, 4, 'the command wake and the later feed wake each cost a read per stream');
  assert.deepEqual(results.true, { reads: 2, snapshots: 2, unchanged: 0 });
});

test('A wake during a read needs a follow-up only for a change after the read began', { timeout: 5000 }, async t => {
  const f = await fixture(t, { changeFeed: true, limits: { pollMs: 10_000, pollFeedMs: 10_000 } });
  const device = await f.login(); const bot = cursorBridge(f, { cursors: true, feedMs: 0 });
  await until(() => bot.held() === 1 && f.app.resourceCounts().feedLive);
  const live = await stream(f.base, device.cookie, {}, guildId, '?protocol=2'); t.after(live.close);
  await until(() => streamSnapshots(live).length === 1);
  await delay(100);
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(release);
  const before = bot.reads.length; bot.hold(gate);
  assert.equal((await sendCommand(f, device)).status, 200);
  await until(() => bot.reads.length === before + 1);
  // That read began after the first command; the second lands while it is in flight.
  assert.equal((await sendCommand(f, device)).status, 200);
  await delay(100); release();
  await until(() => streamSnapshots(live).at(-1)?.revision === 'revision-3');
  await delay(300);
  assert.equal(bot.reads.length - before, 2, 'the held read, then exactly one follow-up');
});

test('Streams announce rotation before their lifetime ends', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { pollMs: 10_000, streamLifetimeMs: 300 } }); const device = await f.login();
  const live = await stream(f.base, device.cookie, {}, guildId, '?protocol=2'); t.after(live.close);
  await until(() => live.ended, 2000);
  assert.match(live.text, /event:rotate\ndata:\{\}\n\n$/);
  assert.equal(f.app.resourceCounts().streams, 0);
});

test('Streams and large JSON replies are compressed when accepted; bootstrap never is', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { pollMs: 40 } }); const device = await f.login();
  const view = snapshot(); view.session.queue = Array.from({ length: 200 }, (_, i) => ({ id: `${i}`.padStart(24, '0'), title: `Song ${i}`, author: 'Artist' }));
  orderedBridge(f, view);
  // Decompress incrementally: each event must arrive while the stream stays open.
  let text = ''; let open = true;
  const gzipped = await new Promise((resolve, reject) => {
    const req = http.get(`${f.base}/api/guilds/${guildId}/events?protocol=2`, { headers: { Cookie: device.cookie, 'Accept-Encoding': 'gzip, deflate, br' }, agent: false }, res => {
      const gunzip = zlib.createGunzip(); gunzip.setEncoding('utf8'); gunzip.on('data', chunk => { text += chunk; }); gunzip.on('error', () => {});
      res.on('data', chunk => gunzip.write(chunk)); res.on('close', () => { open = false; }); res.on('error', () => {});
      resolve({ res, close: () => { res.destroy(); req.destroy(); } });
    });
    req.once('error', reject);
  });
  t.after(gzipped.close);
  assert.equal(gzipped.res.headers['content-encoding'], 'gzip'); assert.equal(gzipped.res.headers.vary, 'Accept-Encoding');
  await until(() => text.includes('event:unchanged'));
  assert.equal(open, true);
  assert.match(text, /event:snapshot\ndata:\{/);
  const plain = await f.request(`/api/guilds/${guildId}`, { headers: { Cookie: device.cookie } });
  assert.equal(plain.headers['content-encoding'], undefined);
  const encoded = await new Promise((resolve, reject) => {
    const url = new URL(f.base);
    http.get({ hostname: url.hostname, port: url.port, path: `/api/guilds/${guildId}`, headers: { Cookie: device.cookie, 'Accept-Encoding': 'br' }, agent: false }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) })); res.on('error', reject);
    }).on('error', reject);
  });
  assert.equal(encoded.headers['content-encoding'], 'br');
  const decoded = JSON.parse(zlib.brotliDecompressSync(encoded.body));
  assert.equal(decoded.session.queue.length, 200); assert.ok(encoded.body.length < Buffer.byteLength(plain.text) / 3);
  assert.equal(Number(encoded.headers['content-length']), encoded.body.length);
  const boot = await f.request('/api/bootstrap', { headers: { Cookie: device.cookie, 'Accept-Encoding': 'gzip, br' } });
  assert.equal(boot.headers['content-encoding'], undefined, 'the CSRF token is never compressed');
  const refused = await f.request(`/api/guilds/${guildId}`, { headers: { Cookie: device.cookie, 'Accept-Encoding': 'br;q=0, gzip;q=0' } });
  assert.equal(refused.headers['content-encoding'], undefined);
});

test('Transport retries a read once when a reused socket resets, and never a write', { timeout: 5000 }, async t => {
  const seen = new Set(); let requests = 0; let reset = true;
  const server = http.createServer((req, res) => {
    requests++;
    const reused = seen.has(req.socket); seen.add(req.socket);
    if (reused && reset) { req.socket.destroy(); return; }
    reply(res, 200, { ok: true, method: req.method });
  });
  const botUrl = await listen(server); t.after(() => { server.closeAllConnections(); server.close(); });
  const transport = new Transport({ botUrl, bridgeToken: secret }, LIMITS); t.after(() => transport.close());
  assert.equal((await transport.send(`${botUrl}/v1/read`)).status, 200);
  const read = await transport.send(`${botUrl}/v1/read`);
  assert.equal(read.status, 200); assert.equal(requests, 3, 'one reset, then one fresh-socket retry');
  requests = 0; reset = true;
  await assert.rejects(transport.send(`${botUrl}/v1/write`, { method: 'POST', body: '{}' }), error => error.status === 503);
  assert.equal(requests, 1, 'a write is never resent');
});

test('Compressed slow readers are closed on the drain deadline too', { timeout: 7000 }, async t => {
  const f = await fixture(t, { limits: { pollMs: 10, drainMs: 100, snapshotBytes: 1024 * 1024 } });
  // Incompressible state, so a paused socket fills behind the encoder.
  const device = await f.login(); f.state.snapshot.session.reason = randomBytes(450 * 1024).toString('base64');
  const socket = net.connect(new URL(f.base).port, '127.0.0.1'); t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write(`GET /api/guilds/${guildId}/events HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: gzip\r\nCookie: ${device.cookie}\r\n\r\n`);
  socket.pause();
  await until(() => f.app.resourceCounts().streams === 1);
  await until(() => f.app.resourceCounts().streams === 0, 4500);
  const polls = f.state.calls.filter(call => call.path === `/v1/guilds/${guildId}`).length;
  assert.ok(polls <= 10, `Slow consumer caused ${polls} unbounded polls`);
});

test('A session revoked while a reply compresses gets no protected data', { timeout: 5000 }, async t => {
  const f = await fixture(t); const device = await f.login();
  f.state.snapshot.session.reason = 'y'.repeat(200 * 1024);
  const zlibModule = await import('node:zlib');
  const original = zlibModule.default.brotliCompress; let release; const held = new Promise(resolve => { release = resolve; });
  let entered = false;
  zlibModule.default.brotliCompress = (...args) => { entered = true; void held.then(() => original(...args)); };
  t.after(() => { zlibModule.default.brotliCompress = original; release(); });
  const read = f.request(`/api/guilds/${guildId}`, { headers: { Cookie: device.cookie, 'Accept-Encoding': 'br' } });
  await until(() => entered);
  assert.equal((await f.request('/auth/logout', { method: 'POST', headers: { Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf } })).status, 200);
  release();
  const reply = await read;
  assert.equal(reply.status, 401); assert.equal(reply.text.includes('yyyy'), false);
});

test('The compressed event writer waits for the socket, not only the encoder', { timeout: 5000 }, async () => {
  const parked = [];
  const res = new Writable({ highWaterMark: 1024, write(chunk, _encoding, done) { parked.push(done); } });
  const out = eventStream({ headers: { 'accept-encoding': 'gzip' } }, res);
  assert.equal(out.encoding, 'gzip');
  // A small event backs up the socket while the encoder itself keeps up.
  out.write(`event:snapshot\ndata:${randomBytes(4096).toString('base64')}\n\n`);
  await until(() => res.writableNeedDrain);
  assert.equal(out.write(': heartbeat\n\n'), false, 'a backed-up socket is backpressure');
  let drained = false; out.onceDrained(() => { drained = true; });
  await delay(100);
  assert.equal(drained, false, 'a blocked socket keeps the writer waiting');
  const release = () => { for (const done of parked.splice(0)) done(); };
  const pump = setInterval(release, 5); await until(() => drained); clearInterval(pump);
  out.end(); release();
});
test('Server-Timing merges the real bot bridge timing into portal API responses', { timeout: 20_000 }, async t => {
  const { portalFixture } = await import('../../../tests/portal-fixtures.js');
  const bot = await portalFixture(t);
  const f = await fixture(t, { botOrigin: bot.origin, botToken: bot.token });
  f.state.identity = '200'; const device = await f.login();
  const full = /^portal;dur=\d+\.\d, bridge;dur=\d+\.\d, bot;dur=\d+\.\d, discord;dur=\d+\.\d$/;
  for (const [label, response] of [
    ['bootstrap', await f.request('/api/bootstrap', { headers: { Cookie: device.cookie } })],
    ['snapshot', await f.request('/api/guilds/100', { headers: { Cookie: device.cookie } })],
    ['library', await f.request('/api/guilds/100/library', { headers: { Cookie: device.cookie } })],
    ['pause', await f.request('/api/guilds/100/commands', { method: 'POST', body: '{"command":"pause"}',
      headers: { Cookie: device.cookie, Origin: origin, 'X-CSRF-Token': device.csrf, 'Content-Type': 'application/json' } })],
  ]) {
    assert.equal(response.status, 200, `${label}: ${response.text}`);
    const timing = response.headers['server-timing'];
    assert.match(timing, full, label);
    const metrics = Object.fromEntries(timing.split(', ').map(part => [part.split(';')[0], Number(part.split('=')[1])]));
    // Each layer contains the one inside it.
    assert.ok(metrics.portal >= metrics.bridge && metrics.bridge >= metrics.bot && metrics.bot >= metrics.discord, `${label}: ${timing}`);
    t.diagnostic(`${label}: Server-Timing: ${timing}`);
  }
});
