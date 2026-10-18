import http from 'node:http';
import path from 'node:path';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { LIMITS, isLoopback } from './config.js';
import { SessionStore, randomToken, tokenHash } from './store.js';
import { Transport, isRetryableReadError } from './transport.js';
import { validateCommand } from './commands.js';
import { HttpError, RateLimiter, busy, invalid, unauthorized, unavailable, cookie, setCookie,
  equal, sameOrigin, securityHeaders, readBody, json, sendError } from './security.js';

export const SESSION_COOKIE = '__Host-vybertron_session';
export const OAUTH_COOKIE = '__Host-vybertron_oauth';
const DISCORD_ISSUER = 'https://discord.com';
const notFound = () => new HttpError(404, 'not_found', 'The requested resource was not found.');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };

function queryOnly(url, allowed) {
  const seen = new Set();
  for (const [key] of url.searchParams) {
    if (!allowed.includes(key) || seen.has(key)) throw invalid();
    seen.add(key);
  }
}

function parseUrl(raw, config, limits) {
  if (!raw || raw.length > limits.urlBytes || !raw.startsWith('/') || raw.startsWith('//') || /[\\\0-\x20\x7f]/.test(raw)) throw invalid();
  let pathname;
  try { pathname = decodeURIComponent(raw.split('?')[0]); } catch { throw invalid(); }
  if (/[\\\0-\x1f\x7f%]/.test(pathname) || pathname.split('/').some(part => part === '.' || part === '..')) throw invalid();
  const url = new URL(raw, config.origin);
  if (url.origin !== config.origin || url.hash) throw invalid();
  return { url, pathname };
}

function snapshotFrame(snapshot, guildId, limits) {
  if (snapshot?.guild?.id !== guildId || typeof snapshot.revision !== 'string' || !snapshot.session) throw unavailable();
  const data = JSON.stringify(snapshot);
  if (Buffer.byteLength(data) > limits.snapshotBytes) throw unavailable();
  return `event:snapshot\ndata:${data}\n\n`;
}

function configurationData(data, guildId) {
  const item = value => value && typeof value.id === 'string' && /^\d{1,20}$/.test(value.id) && typeof value.name === 'string';
  if (data?.guildId !== guildId || !Array.isArray(data.channels) || data.channels.length > 500 ||
    !Array.isArray(data.roles) || data.roles.length > 250 ||
    !data.channels.every(value => item(value) && ['voice', 'text'].includes(value.type)) || !data.roles.every(item)) throw unavailable();
  return data;
}

// A playlist import preview: counts, short notes and up to 100 song names.
function importPreview(data) {
  const text = max => value => typeof value === 'string' && value.length <= max;
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000;
  if (!data || typeof data !== 'object' || !/^[a-f0-9]{32}$/.test(data.id ?? '') && data.id !== null
    || !['favorites', 'mix'].includes(data.target) || !(data.name === null || text(40)(data.name)) || !text(100)(data.title)
    || !['found', 'toAdd', 'duplicates', 'unmatched', 'overLimit', 'limit'].every(key => count(data[key]))
    || !Array.isArray(data.notes) || data.notes.length > 4 || !data.notes.every(text(200))
    || !Array.isArray(data.tracks) || data.tracks.length > 100 || data.tracks.length !== data.toAdd
    || !data.tracks.every(track => track && text(180)(track.title) && text(120)(track.author))) throw unavailable();
  return { id: data.id, target: data.target, name: data.name, title: data.title, found: data.found, toAdd: data.toAdd, duplicates: data.duplicates,
    unmatched: data.unmatched, overLimit: data.overLimit, limit: data.limit, notes: data.notes, tracks: data.tracks.map(({ title, author }) => ({ title, author })) };
}

// Test endpoints/timing overrides can only be supplied by a loopback nonproduction
// caller; the production entrypoint has no fixture/test authentication mechanism.
export async function createPortalServer(config, testOptions = {}) {
  if (Object.keys(testOptions).length && (config.production || !isLoopback(config.host))) {
    throw new Error('Test transports are forbidden outside explicit loopback nonproduction use');
  }
  const effectiveConfig = { ...config };
  if (testOptions.discordOrigin) {
    const discord = new URL(testOptions.discordOrigin);
    if (!['http:', 'https:'].includes(discord.protocol) || !isLoopback(discord.hostname) || discord.username || discord.password || discord.pathname !== '/' || discord.search || discord.hash) throw new Error('Test Discord transport must be loopback');
    effectiveConfig.discordTokenUrl = new URL('/token', discord).href;
    effectiveConfig.discordUserUrl = new URL('/users/@me', discord).href;
  }
  const limits = Object.freeze({ ...LIMITS, ...testOptions.limits });
  const now = testOptions.now || Date.now;
  const store = new SessionStore(effectiveConfig, limits, now); await store.open();
  const transport = new Transport(effectiveConfig, limits);
  const limiter = new RateLimiter(limits.rateKeys, now);
  const anonymousLimiter = new RateLimiter(limits.rateKeys, now);
  const pendingOAuth = new Map(); const streams = new Set(); const commandReaders = new Set();
  let processing = 0; let stops = 0; let closing = false;
  // Production follows the bot's change feed; test servers opt in explicitly.
  const followChanges = Object.keys(testOptions).length ? testOptions.changeFeed === true : true;
  const feedController = new AbortController(); let feedLive = false; let following;

  function sessionFor(req) {
    const token = cookie(req, SESSION_COOKIE); const session = store.get(token);
    if (!session) throw unauthorized();
    return { token, session };
  }

  function checkCsrf(req, session) {
    sameOrigin(req, config);
    if (!equal(req.headers['x-csrf-token'], session.csrfToken)) throw new HttpError(403, 'forbidden', 'Refresh the portal before making this change.');
  }

  async function serveStatic(req, res, pathname) {
    if (pathname.split('/').some(part => part.startsWith('.') && part !== '')) throw notFound();
    const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
    let root;
    try { root = await fs.realpath(config.webDist); } catch { throw unavailable(); }
    let file = path.resolve(root, requested);
    if (!file.startsWith(`${root}${path.sep}`)) throw notFound();
    try { file = await fs.realpath(file); } catch {
      if (path.extname(requested)) throw notFound();
      file = path.join(root, 'index.html');
    }
    if (!file.startsWith(`${root}${path.sep}`) || !types[path.extname(file).toLowerCase()]) throw notFound();
    let handle;
    try { handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)); } catch { throw notFound(); }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limits.staticBytes) throw notFound();
      if (res.destroyed) return;
      const ext = path.extname(file).toLowerCase();
      const isWorker = /(?:^|[/\\])(?:sw|service-worker|workbox[^/\\]*)\.js$/i.test(file);
      // The PWA share target's query holds shared text: no browser cache may keep it.
      res.setHeader('Cache-Control', isWorker || pathname === '/share' ? 'no-store' : /[-.][a-zA-Z0-9_-]{8,}\.(?:js|css|woff2?)$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
      if (isWorker) res.setHeader('Service-Worker-Allowed', '/');
      res.writeHead(200, { 'Content-Type': types[ext], 'Content-Length': stat.size });
      if (req.method === 'HEAD') { res.end(); return; }
      // The stream must own the FileHandle, not its numeric descriptor. Destroy
      // closes even an autoClose:false stream; closing that descriptor again can
      // close a different file/socket that has already reused it on Unix.
      const stream = handle.createReadStream();
      handle = null;
      res.once('close', () => stream.destroy());
      stream.once('error', () => res.destroy());
      stream.pipe(res);
    } finally { await handle?.close(); }
  }

  async function events(req, res, guildId, token, session, signal) {
    if (streams.size >= limits.streams || [...streams].filter(stream => stream.sessionKey === session.key).length >= limits.streamsPerSession) throw busy();
    const record = { sessionKey: session.key, guildId, close: null, wake: null, reschedule: null }; streams.add(record);
    let pollTimer; let heartbeatTimer; let drainTimer; let drainWait; let ended = false; let writing = false; let unblock;
    const began = now(); let failures = 0; let reading = true; let pendingWake = false;
    const pollController = new AbortController();
    const pollSignal = AbortSignal.any([signal, pollController.signal]);
    const close = () => {
      if (ended) return;
      ended = true; clearTimeout(pollTimer); clearTimeout(heartbeatTimer); clearTimeout(drainTimer); streams.delete(record);
      pollController.abort();
      unblock?.(); if (!res.writableEnded) res.end();
    };
    record.close = close;
    res.once('close', close);
    async function write(frame, protectedState = false) {
      if (writing && !(await drainWait)) return false;
      if (ended || res.destroyed || signal.aborted) return false;
      if (protectedState && !active()) return false;
      writing = true;
      try {
        if (res.write(frame)) return true;
        drainWait = new Promise(resolve => {
          let settled = false;
          const finish = success => {
            if (settled) return; settled = true; clearTimeout(drainTimer); res.off('drain', onDrain); unblock = null; resolve(success);
          };
          const onDrain = () => finish(true); unblock = () => finish(false);
          res.once('drain', onDrain);
          drainTimer = setTimeout(() => { res.destroy(); close(); finish(false); }, limits.drainMs); drainTimer.unref();
        });
        return await drainWait;
      } finally { writing = false; drainWait = null; }
    }
    const errorFrame = error => {
      const safe = error instanceof HttpError ? error : unavailable();
      return `event:error\ndata:${JSON.stringify({ error: { status: safe.status, code: safe.code, message: safe.message } })}\n\n`;
    };
    const fail = async error => {
      try { if (!writing) await write(errorFrame(error)); } finally { close(); }
    };
    const active = () => {
      if (ended || signal.aborted) return false;
      if (!store.get(token)) throw unauthorized();
      if (closing || now() - began >= limits.streamLifetimeMs) { close(); return false; }
      return true;
    };
    const schedule = () => {
      if (ended) return;
      const wait = Math.min(limits.pollRetryMaxMs, limits.pollMs * 2 ** Math.min(failures, 10));
      // The feed wakes this stream on change; polling then only bounds how long
      // Discord-side revocation can stay unobserved.
      const base = feedLive && !failures ? limits.pollFeedMs : limits.pollMs;
      clearTimeout(pollTimer);
      pollTimer = setTimeout(tick, pendingWake && !failures ? 0 : Math.max(base, wait)); pollTimer.unref();
    };
    record.reschedule = () => { if (!ended && !reading && !failures) schedule(); };
    record.wake = () => {
      if (ended || pendingWake) return;
      // One bounded notification per stream. A read consumes it only when it
      // starts, so commands completed during that read require another read.
      pendingWake = true;
      if (!reading && !failures) schedule();
      // A retry timer is never reset/shortened by commands during backoff.
    };
    const readFailure = async error => {
      if (!active()) return;
      // A read error invalidates the client's freshness, but transient bridge
      // failures must not create reconnect/probe storms. No snapshot is retained
      // or resent: every recovery attempt performs fresh trusted policy checks.
      if (isRetryableReadError(error)) {
        failures++;
        await write(errorFrame(error));
      } else await fail(error);
    };
    const heartbeat = async () => {
      try {
        if (!active()) return;
        // Comments contain no protected state and must keep flowing while Discord
        // verification is slow. Skip a blocked writer instead of buffering more.
        if (!writing && !(await write(': heartbeat\n\n'))) return;
        if (!ended) { heartbeatTimer = setTimeout(heartbeat, limits.heartbeatMs); heartbeatTimer.unref(); }
      } catch (error) { await fail(error); }
    };
    const tick = async () => {
      if (reading || ended) return;
      reading = true; pendingWake = false;
      try {
        if (!active()) return;
        // The bridge performs fresh Discord policy evaluation on every poll,
        // even if the returned revision has not changed.
        let snapshot;
        try { snapshot = await transport.bridge(`/v1/guilds/${guildId}`, session.actorId, { signal: pollSignal, shareRead: true }); }
        catch (error) { await readFailure(error); return; }
        if (!active()) return;
        if (!(await write(snapshotFrame(snapshot, guildId, limits), true))) return;
        failures = 0;
      } catch (error) { await fail(error); }
      finally { reading = false; schedule(); }
    };
    try {
      let initial; let initialError;
      try { initial = await transport.bridge(`/v1/guilds/${guildId}`, session.actorId, { signal: pollSignal, shareRead: true }); }
      catch (error) {
        if (!isRetryableReadError(error)) throw error;
        initialError = error;
      }
      if (!active()) return;
      const frame = initialError ? errorFrame(initialError) : snapshotFrame(initial, guildId, limits);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
      req.socket.setTimeout(0);
      if (await write(`retry: 5000\n\n: connected\n\n${frame}`, !initialError)) {
        failures = initialError ? 1 : 0;
        heartbeatTimer = setTimeout(heartbeat, limits.heartbeatMs); heartbeatTimer.unref();
      }
    } catch (error) {
      clearTimeout(pollTimer); clearTimeout(heartbeatTimer); clearTimeout(drainTimer); streams.delete(record); ended = true;
      pollController.abort();
      res.off('close', close); throw error;
    } finally { reading = false; schedule(); }
  }

  async function followFeed() {
    let instance = ''; let after = ''; let failures = 0;
    const signal = feedController.signal;
    while (!closing && !signal.aborted) {
      try {
        const data = await transport.changes(instance, after, signal);
        if (closing) return;
        // A reset, new bot instance or recovered feed may have missed changes.
        const all = data.reset || data.instanceId !== instance || !feedLive;
        const changed = new Set(data.guildIds);
        feedLive = true; failures = 0; instance = data.instanceId; after = data.sequence;
        for (const stream of streams) if (all || changed.has(stream.guildId)) stream.wake();
      } catch {
        if (closing || signal.aborted) return;
        if (feedLive) { feedLive = false; for (const stream of streams) stream.reschedule(); }
        const wait = Math.min(limits.changesRetryMaxMs, 1000 * 2 ** Math.min(failures++, 10));
        await new Promise(resolve => {
          const timer = setTimeout(done, wait); timer.unref();
          function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
          signal.addEventListener('abort', done, { once: true });
        });
      }
    }
  }

  const server = http.createServer({ maxHeaderSize: limits.headerBytes }, async (req, res) => {
    securityHeaders(res, config.production);
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    let admission = null; let reader; let trusted = false; let anonymousCounted = false;
    const admitOrdinary = () => {
      if (processing >= limits.requests) throw busy();
      processing++; admission = 'ordinary';
    };
    const anonymousBudget = () => {
      anonymousCounted = true;
      anonymousLimiter.check(`global:${req.socket.remoteAddress}`, limits.anonymousRequests);
    };
    try {
      if (closing) throw busy();
      const { url, pathname } = parseUrl(req.url, config, limits);
      if (!['GET', 'HEAD', 'POST'].includes(req.method)) throw new HttpError(405, 'method_not_allowed', 'This HTTP method is not supported.');
      const commandRequest = req.method === 'POST' && /^\/api\/guilds\/\d{1,20}\/commands$/.test(pathname);
      if (!commandRequest && (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0)) throw invalid();
      if (commandRequest) {
        // The contract uses one commands URL, so priority is known only after a
        // bounded body read. Authenticate first; these readers cannot consume
        // ordinary handlers or the separately reserved, validated Stop handlers.
        queryOnly(url, []);
        const { token, session } = sessionFor(req); checkCsrf(req, session);
        trusted = true;
        if (commandReaders.size >= limits.commandReaders) {
          // Stop has no separate URL/header and cannot be classified before its
          // JSON arrives. Replace the oldest incomplete authenticated upload so
          // slow uploads cannot lock every priority-discovery slot for ten seconds.
          // Nothing from an evicted reader has been dispatched to the bot.
          const oldest = commandReaders.values().next().value;
          if (!oldest) throw busy();
          commandReaders.delete(oldest); oldest.abort(busy());
        }
        reader = new AbortController(); commandReaders.add(reader); admission = 'body';
        const command = validateCommand(await readBody(req, limits.bodyBytes, limits.requestMs, reader.signal));
        commandReaders.delete(reader); admission = null;
        if (command.command === 'stop') {
          if (stops >= limits.stopRequests) throw busy();
          stops++; admission = 'stop';
          limiter.check(`stop:${session.key}`, 30);
        } else {
          admitOrdinary();
          limiter.check(`session:${session.key}`, 120);
          limiter.check(`commands:${session.key}`, 30);
        }
        // No await between this live-token check and bridge dispatch: logout,
        // rotation or expiry during the body read must never send an actor write.
        if (!store.get(token)) throw unauthorized();
        const guildId = pathname.split('/')[3];
        req.setTimeout(limits.commandMs + 1000);
        const result = await transport.bridge(`/v1/guilds/${guildId}/commands`, session.actorId, { command, signal: controller.signal });
        if (!store.get(token)) throw unauthorized();
        if (result.ok !== true || typeof result.message !== 'string' || result.message.length > 2000) throw unavailable();
        snapshotFrame(result.snapshot, guildId, limits);
        transport.fenceSharedReads(`/v1/guilds/${guildId}`);
        // Wake only existing same-guild streams; each uses its own trusted actor
        // and fresh bridge read. Never distribute the command actor's snapshot.
        for (const stream of streams) if (stream.guildId === guildId) stream.wake();
        const preview = result.preview === undefined ? undefined : importPreview(result.preview);
        json(res, 200, { ok: true, message: result.message, snapshot: result.snapshot, ...(preview && { preview }) }); return;
      }
      admitOrdinary();
      if (pathname === '/health' && req.method === 'GET') {
        anonymousBudget();
        queryOnly(url, []);
        let botReady = false; let webReady = false;
        try { botReady = (await transport.bridge('/health', null, { signal: controller.signal })).ready === true; } catch {}
        try { webReady = (await fs.stat(path.join(config.webDist, 'index.html'))).isFile(); } catch {}
        const ready = botReady && webReady && store.healthy;
        json(res, ready ? 200 : 503, { ready, portalReady: store.healthy, botReady, webReady }); return;
      }
      if (pathname.startsWith('/auth/') || pathname === '/auth') {
        if (pathname === '/auth/discord' && req.method === 'GET') {
          queryOnly(url, []); sameOrigin(req, config, { optional: true });
          anonymousBudget(); anonymousLimiter.check(`oauth-start:${req.socket.remoteAddress}`, limits.oauthStarts);
          for (const [id, state] of pendingOAuth) if (state.until <= now()) pendingOAuth.delete(id);
          const old = cookie(req, OAUTH_COOKIE); if (old) pendingOAuth.delete(tokenHash(old));
          if (pendingOAuth.size >= limits.pendingOAuth) throw busy();
          const browserToken = randomToken(); const state = randomToken();
          pendingOAuth.set(tokenHash(browserToken), { state, until: now() + limits.oauthMs });
          const redirect = new URL(config.discordAuthorizeUrl);
          for (const [key, value] of Object.entries({ client_id: config.clientId, response_type: 'code', scope: 'identify',
            redirect_uri: config.callbackUrl, state })) redirect.searchParams.set(key, value);
          res.writeHead(302, { Location: redirect.href, 'Set-Cookie': setCookie(OAUTH_COOKIE, browserToken, limits.oauthMs / 1000) }); res.end(); return;
        }
        if (pathname === '/auth/discord/callback' && req.method === 'GET') {
          // Single-use, cookie-bound, expiring state supplies callback admission;
          // an anonymous peer-wide start quota must not block a valid callback.
          // Discord adds RFC 9207 `iss`; when present it must name Discord.
          queryOnly(url, ['code', 'state', 'iss', 'error', 'error_description']);
          const browserToken = cookie(req, OAUTH_COOKIE);
          const key = browserToken ? tokenHash(browserToken) : null;
          const pending = pendingOAuth.get(key); pendingOAuth.delete(key);
          res.setHeader('Set-Cookie', setCookie(OAUTH_COOKIE, '', 0));
          if (!pending || pending.until <= now() || !equal(url.searchParams.get('state'), pending.state)
            || (url.searchParams.has('iss') && url.searchParams.get('iss') !== DISCORD_ISSUER)) throw invalid();
          trusted = true;
          if (url.searchParams.has('error')) throw new HttpError(401, 'oauth_denied', 'Discord sign-in was not completed.');
          const code = url.searchParams.get('code');
          if (!code || code.length > 2048 || !/^[\x21-\x7e]+$/.test(code)) throw invalid();
          const actorId = await transport.discordIdentity(code, controller.signal);
          // Obtain the bot's freshly verified viewer before creating a session.
          const bootstrap = await transport.bridge('/v1/bootstrap', actorId, { signal: controller.signal });
          if (bootstrap.viewer?.id !== actorId || !Array.isArray(bootstrap.guilds)) throw unavailable();
          const previousToken = cookie(req, SESSION_COOKIE);
          const created = await store.create(actorId, previousToken);
          if (previousToken) for (const stream of streams) if (stream.sessionKey === tokenHash(previousToken)) stream.close();
          res.writeHead(302, { Location: '/', 'Set-Cookie': [setCookie(OAUTH_COOKIE, '', 0), setCookie(SESSION_COOKIE, created.token, limits.sessionMs / 1000)] }); res.end(); return;
        }
        if (pathname === '/auth/logout' && req.method === 'POST') {
          queryOnly(url, []); const { token, session } = sessionFor(req); checkCsrf(req, session);
          trusted = true;
          limiter.check(`logout:${session.key}`, 30);
          await store.destroy(token);
          for (const stream of streams) if (stream.sessionKey === session.key) stream.close();
          res.setHeader('Set-Cookie', setCookie(SESSION_COOKIE, '', 0)); json(res, 200, { ok: true }); return;
        }
        anonymousBudget();
        throw notFound();
      }
      if (pathname.startsWith('/api/') || pathname === '/api') {
        sameOrigin(req, config, { optional: req.method === 'GET' });
        const { token, session } = sessionFor(req);
        trusted = true;
        limiter.check(`session:${session.key}`, 120);
        if (pathname === '/api/bootstrap' && req.method === 'GET') {
          queryOnly(url, []);
          const bootstrap = await transport.bridge('/v1/bootstrap', session.actorId, { signal: controller.signal });
          if (!store.get(token)) throw unauthorized();
          if (bootstrap.viewer?.id !== session.actorId || !Array.isArray(bootstrap.guilds)) throw unavailable();
          const voiceGuildId = bootstrap.guilds.some(guild => guild?.id === bootstrap.voiceGuildId) ? bootstrap.voiceGuildId : null;
          // Only this app's own Discord install link is ever offered to the browser.
          const inviteUrl = typeof bootstrap.inviteUrl === 'string' && bootstrap.inviteUrl.length <= 512
            && bootstrap.inviteUrl.startsWith(`${config.discordAuthorizeUrl}?client_id=${config.clientId}&`) ? bootstrap.inviteUrl : null;
          json(res, 200, { viewer: bootstrap.viewer, guilds: bootstrap.guilds, voiceGuildId, filters: bootstrap.filters,
            commands: bootstrap.commands, inviteUrl, csrfToken: session.csrfToken }); return;
        }
        if (pathname === '/api/stats/requests/clear' && req.method === 'POST') {
          // Clears the signed-in listener's own request history in every server.
          queryOnly(url, []); checkCsrf(req, session);
          limiter.check(`stats-clear:${session.key}`, 10);
          const result = await transport.bridge('/v1/stats/requests/clear', session.actorId, { method: 'POST', signal: controller.signal });
          if (!store.get(token)) throw unauthorized();
          if (result?.ok !== true || !Number.isSafeInteger(result.cleared) || result.cleared < 0) throw unavailable();
          json(res, 200, { ok: true, cleared: result.cleared }); return;
        }
        const audio = /^\/api\/guilds\/(\d{1,20})\/audio\/([\w-]{11})$/.exec(pathname);
        if (audio && req.method === 'GET') {
          // This device's player. The browser's media element sends only byte ranges.
          queryOnly(url, []);
          const range = req.headers.range;
          if (range !== undefined && !/^bytes=\d{0,15}-\d{0,15}$/.test(range)) throw invalid();
          await transport.audio(`/v1/guilds/${audio[1]}/audio/${audio[2]}`, session.actorId, { range, signal: controller.signal, res }); return;
        }
        const match = /^\/api\/guilds\/(\d{1,20})(?:\/(configuration|library|search|commands|diagnostics|activity|events|stats|recap|lyrics))?$/.exec(pathname);
        if (!match) throw notFound();
        const [, guildId, resource] = match;
        queryOnly(url, resource === 'search' ? ['query'] : ['stats', 'recap'].includes(resource) ? ['window'] : []);
        const endpoint = `/v1/guilds/${guildId}${resource ? `/${resource}` : ''}`;
        if (req.method !== 'GET' || resource === 'commands') throw notFound();
        if (resource === 'events') { await events(req, res, guildId, token, session, controller.signal); return; }
        const query = {};
        if (resource === 'search') {
          const value = url.searchParams.get('query');
          if (!value || value.length > 200 || /[\0-\x1f\x7f]/.test(value)) throw invalid();
          query.query = value;
        }
        if (resource === 'stats' && url.searchParams.has('window')) {
          const window = url.searchParams.get('window');
          if (!['7d', '30d', '90d', '365d', 'all'].includes(window)) throw invalid();
          query.window = window;
        }
        if (resource === 'recap' && url.searchParams.has('window')) {
          const window = url.searchParams.get('window');
          if (!['7d', '30d', '90d', '365d'].includes(window)) throw invalid();
          query.window = window;
        }
        const data = await transport.bridge(endpoint, session.actorId, { query, signal: controller.signal });
        if (!store.get(token)) throw unauthorized();
        if (!resource) snapshotFrame(data, guildId, limits);
        if (resource === 'configuration') configurationData(data, guildId);
        json(res, 200, data); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw notFound();
      anonymousBudget();
      await serveStatic(req, res, pathname);
    } catch (error) {
      // Invalid/unauthenticated requests remain bounded by the anonymous peer
      // aggregate, while verified device/state routes never share that quota.
      if (!trusted && !anonymousCounted) {
        // eslint-disable-next-line no-ex-assign -- the rate limit replaces the original error response.
        try { anonymousBudget(); } catch (limited) { error = limited; }
      }
      if (!req.complete) { res.setHeader('Connection', 'close'); req.resume(); }
      sendError(res, error);
    } finally {
      if (admission === 'ordinary') processing--;
      else if (admission === 'body') commandReaders.delete(reader);
      else if (admission === 'stop') stops--;
      if (req.method === 'POST' && res.writableEnded && !req.socket.destroyed) req.setTimeout(30_000);
    }
  });
  server.maxConnections = limits.connections;
  server.headersTimeout = 5000; server.requestTimeout = limits.requestMs;
  server.keepAliveTimeout = 5000; server.setTimeout(30_000, socket => socket.destroy());
  server.on('clientError', (_error, socket) => {
    const body = '{"error":{"code":"invalid_input","message":"The HTTP request is invalid."}}';
    socket.end(`HTTP/1.1 400 Bad Request\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        if (followChanges && !following) following = followFeed();
        resolve(server.address());
      });
    }),
    async close() {
      closing = true; feedController.abort(); for (const stream of streams) stream.close();
      transport.close();
      const stopped = new Promise(resolve => server.close(resolve)); server.closeAllConnections();
      await stopped; await following; await store.close(); pendingOAuth.clear();
    },
    // Resource counts contain no identity, credentials, or music data.
    resourceCounts: () => ({ feedLive, streams: streams.size, requests: processing + commandReaders.size + stops,
      ordinaryRequests: processing, commandReaders: commandReaders.size, stops, upstream: transport.active,
      ordinaryUpstream: transport.ordinary, stopUpstream: transport.stops, pendingOAuth: pendingOAuth.size }),
  };
}
