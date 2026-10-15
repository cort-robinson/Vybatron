import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { loadCommandsData } from '../commands/index.js';
import { getHealth } from '../health.js';
import { searchMusic } from '../utils/search.js';
import { validatePlaybackQuery } from '../utils/query.js';
import { withTimeout } from '../utils/enqueue.js';
import { validId } from '../utils/library.js';
import { actorVoiceId, createPortalPolicy } from './policy.js';
import { FILTERS, actorProjection, guildProjection, trackProjection, snapshotProjection, libraryProjection, activityProjection, configurationProjection, createRevisions, statsProjection, STATS_WINDOW_IDS } from './projection.js';
import { publicCommands, executePortalCommand } from './commands.js';
import { fail, safeError } from './errors.js';
import { createCommandTimings, commandTimingSpan } from './timing.js';
import { createChangeFeed } from './changes.js';

const hash = value => createHash('sha256').update(value).digest();
function json(response, status, body, maxBytes) {
  if (response.destroyed || response.writableEnded) return;
  let serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > maxBytes) { status = 503; serialized = JSON.stringify({ error: { code: 'projection_limit', message: 'This server snapshot exceeds the safe response limit.' } }); }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(serialized);
}
async function readBody(request, maxBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) fail(400, 'invalid_json', 'Send a JSON command body.');
  if (Number(request.headers['content-length']) > maxBytes) fail(400, 'body_limit', 'The command body is too large.');
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) fail(400, 'body_limit', 'The command body is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'invalid_json', 'The command body is not valid JSON.'); }
}

// This adapter is the sole bot-side portal entry point. It only uses the
// existing client.library and hardened Lavalink manager/command implementations.
export function startPortalBridge(client, {
  token = process.env.PORTAL_BRIDGE_TOKEN, host = process.env.PORTAL_BRIDGE_HOST || '127.0.0.1', port = Number(process.env.PORTAL_BRIDGE_PORT || 3010),
  operatorIds = (process.env.PORTAL_OPERATOR_IDS || '').split(',').map(id => id.trim()).filter(Boolean), logger = console,
  maxInFlight = 16, maxBodyBytes = 16 * 1024, maxResponseBytes = 4 * 1024 * 1024,
  maxRequestsPerMinute = 600,
} = {}) {
  if (!token) return { enabled: false, server: null, ready: Promise.resolve(), close: async () => {}, dispose: async () => {} };
  if (typeof token !== 'string' || Buffer.byteLength(token) < 32 || Buffer.byteLength(token) > 512 || /[\s\u0000]/.test(token)) throw new Error('Invalid PORTAL_BRIDGE_TOKEN configuration.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORTAL_BRIDGE_PORT configuration.');
  for (const [value, minimum, maximum] of [[maxInFlight, 1, 32], [maxBodyBytes, 1024, 65536], [maxResponseBytes, 1024, 4 * 1024 * 1024], [maxRequestsPerMinute, 1, 1200]]) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error('Invalid private bridge resource limit.');
  }
  const secret = hash(`Bearer ${token}`);
  const policy = createPortalPolicy(client, { operatorIds });
  const revisions = createRevisions(client);
  const timings = createCommandTimings();
  const changes = createChangeFeed(client, revisions);
  const measuredPolicy = { ...policy, guild: (...args) => commandTimingSpan('authorization', () => policy.guild(...args)) };
  const commands = loadCommandsData();
  // Every rejection is observed even if no caller waits for startup readiness.
  void commands.catch(() => {});
  let inFlight = 0; let ordinaryInFlight = 0; let stopInFlight = 0;
  let closing = false; const work = new Set(); const sockets = new Set();
  let rateStart = Date.now(); let rateCount = 0; let stopRateCount = 0;
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    // A disconnected portal socket must not reach the bot's fatal process
    // handler. Body readers still observe request failures through iteration.
    request.on('error', () => {}); response.on('error', () => {});
    const run = async () => {
      if (typeof request.headers.authorization !== 'string' || request.headers.authorization.length > 1024 || !timingSafeEqual(secret, hash(request.headers.authorization))) fail(401, 'unauthenticated', 'Bridge authentication is required.');
      if (request.headers.origin !== undefined || request.headers['access-control-request-method'] !== undefined) fail(403, 'browser_forbidden', 'Direct browser access is unavailable.');
      if (closing) fail(503, 'bridge_closing', 'The bridge is closing.');
      if (request.method === 'GET' && request.url?.length <= 256 && request.url.startsWith('/v1/changes?')) {
        // A held wake-up long poll for the portal API. It carries guild IDs only,
        // so it sits outside the protected-read admission and request budget.
        const url = new URL(request.url, 'http://bridge.invalid');
        const after = url.searchParams.get('after');
        const abort = new AbortController(); response.once('close', () => abort.abort());
        return json(response, 200, await changes.next({ instance: url.searchParams.get('instance') || '',
          after: /^\d{1,15}$/.test(after || '') ? Number(after) : Number.NaN, signal: abort.signal }), maxResponseBytes);
      }
      // Two bounded slots remain available to inspect/serve Stop while normal
      // requests are saturated by slow source lookups.
      if (inFlight >= maxInFlight + 2) fail(429, 'busy', 'The bridge is busy. Try again shortly.');
      if (!request.url || request.url.length > 2048) fail(400, 'invalid_url', 'The request URL is too long.');
      inFlight++;
      let admitted = null;
      try {
        const url = new URL(request.url, 'http://bridge.invalid');
        const isCommand = /^\/v1\/guilds\/\d{1,22}\/commands$/.test(url.pathname) && request.method === 'POST';
        const body = isCommand ? await readBody(request, maxBodyBytes) : null;
        const isStop = isCommand && body?.command === 'stop';
        if (Date.now() - rateStart >= 60_000) { rateStart = Date.now(); rateCount = 0; stopRateCount = 0; }
        if (isStop ? ++stopRateCount > 30 : ++rateCount > maxRequestsPerMinute) fail(429, 'busy', 'The bridge request limit was reached. Try again shortly.');
        if (isStop ? stopInFlight >= 2 : ordinaryInFlight >= maxInFlight) fail(429, 'busy', 'The bridge is busy. Try again shortly.');
        admitted = isStop ? 'stop' : 'ordinary';
        if (isStop) stopInFlight++; else ordinaryInFlight++;
        const commandMap = await commands;
        if (url.pathname === '/health' && request.method === 'GET') return json(response, 200, { ready: getHealth(client).ready }, maxResponseBytes);
        if (url.pathname === '/v1/latency' && request.method === 'GET') {
          const who = await policy.identity(url.searchParams.get('actorId'), { fresh: true });
          if (!who.maintainer) fail(403, 'maintainer_required', 'Maintainer access is required.');
          return json(response, 200, timings.snapshot(), maxResponseBytes);
        }
        if (url.pathname === '/v1/bootstrap' && request.method === 'GET') {
          const actorId = url.searchParams.get('actorId');
          const who = await policy.identity(actorId);
          const guilds = [];
          // The server whose voice the viewer is in, so the portal opens there.
          let voiceGuildId = null;
          // Discord's installed guild inventory is authoritative and bounded.
          const ids = [...client.guilds.cache.keys()].slice(0, 1000);
          for (let start = 0; start < ids.length; start += 4) {
            const results = await Promise.all(ids.slice(start, start + 4).map(async id => {
              try {
                const context = await policy.guild(actorId, id, who, { channelScope: 'none' });
                if (!voiceGuildId && validId(actorVoiceId(context.member))) voiceGuildId = context.guild.id;
                return guildProjection(context);
              } catch (error) { if (error?.status === 404) return null; throw error; }
            }));
            guilds.push(...results.filter(Boolean));
          }
          return json(response, 200, { viewer: { id: who.user.id, username: who.user.username.slice(0, 80), displayName: actorProjection(who.user).displayName, avatarUrl: actorProjection(who.user).avatarUrl, maintainer: who.maintainer }, guilds, voiceGuildId, filters: FILTERS, commands: publicCommands(commandMap) }, maxResponseBytes);
        }
        if (url.pathname === '/v1/stats/requests/clear' && request.method === 'POST') {
          // Personal data across every server: identity only, never a guild grant.
          const who = await policy.identity(url.searchParams.get('actorId'), { fresh: true });
          if (!client.stats?.available) fail(503, 'stats_unavailable', 'Listening stats are unavailable right now. Playback is unaffected.');
          let cleared;
          try { cleared = client.stats.clearRequests(who.user.id); } catch { fail(503, 'stats_unavailable', 'Your request stats could not be cleared. Try again shortly.'); }
          return json(response, 200, { ok: true, cleared }, maxResponseBytes);
        }
        const match = url.pathname.match(/^\/v1\/guilds\/(\d{1,22})(?:\/(library|search|commands|diagnostics|activity|configuration|stats))?$/);
        if (!match) fail(404, 'not_found', 'That bridge endpoint does not exist.');
        const [, guildId, resource] = match;
        if (resource === 'commands' && request.method === 'POST') return json(response, 200, await timings.run(body?.command,
          () => executePortalCommand(client, measuredPolicy, revisions, commandMap, guildId, body)), maxResponseBytes);
        if (request.method !== 'GET' || resource === 'commands') fail(400, 'invalid_method', 'That request method is unsupported.');
        const actorId = url.searchParams.get('actorId');
        const channelScope = ['library', 'stats'].includes(resource) ? 'history' : resource === 'configuration' ? 'configuration' : ['activity', 'diagnostics'].includes(resource) ? 'none' : 'session';
        const context = await policy.guild(actorId, guildId, undefined, { channelScope });
        let result;
        if (!resource) result = snapshotProjection(client, context, revisions.revision(guildId), revisions.nextSnapshot());
        if (resource === 'library') result = libraryProjection(client, context);
        if (resource === 'stats') {
          const window = url.searchParams.get('window') || '30d';
          if (!STATS_WINDOW_IDS.includes(window)) fail(400, 'invalid_window', 'Choose a supported stats window.');
          result = statsProjection(client, context, window);
        }
        if (resource === 'configuration') result = configurationProjection(context);
        if (resource === 'activity' || resource === 'diagnostics') {
          if (!context.admin) fail(403, 'admin_required', 'Manage Server permission is required.');
          if (resource === 'activity') result = activityProjection(client, guildId);
          else {
            const health = getHealth(client);
            const summary = client.lavalink?.playbackRecovery?.summary?.();
            result = { botReady: health.discordReady, audioReady: health.audioReady, uptimeSeconds: Math.floor(process.uptime()), recoveryState: summary?.recovering ? 'recovering' : health.audioReady ? 'ready' : 'unavailable', lastError: null };
          }
        }
        if (resource === 'search') {
          if (!context.member) fail(403, 'membership_required', 'Join this server to search its music catalog.');
          const query = url.searchParams.get('query');
          if (validatePlaybackQuery(query) || String(query).startsWith('autocomplete:')) fail(400, 'invalid_query', 'Enter a song title or a supported public catalog link.');
          const node = client.lavalink?.nodeManager?.leastUsedNodes?.()[0];
          if (!node?.connected || !node.search) fail(503, 'audio_unavailable', 'The music catalog is temporarily unavailable.');
          const found = await searchMusic(node, query, context.user, { timeoutMs: 8000, nativeTimeoutMs: 1500, spotifyTimeoutMs: 20_000 });
          // Membership may disappear during a slow import. Recheck before data.
          const fresh = await policy.guild(actorId, guildId);
          if (!fresh.member) fail(403, 'membership_required', 'Join this server to search its music catalog.');
          result = { tracks: (found?.tracks || []).slice(0, 50).map(track => trackProjection(track)), notice: found?.spotifyImport ? 'Spotify catalog results are matched to playable recordings.' : found?.tracks?.length ? null : 'No playable matches were found.' };
        }
        return json(response, 200, result, maxResponseBytes);
      } finally { inFlight--; if (admitted === 'stop') stopInFlight--; if (admitted === 'ordinary') ordinaryInFlight--; }
    };
    // Timeouts only bound the transport. An accepted command is never replayed
    // or abandoned mid-write; hardened source deadlines/fences finish its work.
    const task = withTimeout(run(), 90_000).catch(error => {
      const safe = safeError(error); json(response, safe.status, { error: { code: safe.code, message: safe.message } }, maxResponseBytes);
    });
    work.add(task); void task.finally(() => work.delete(task)).catch(() => {});
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); if (sockets.size > 48) socket.destroy(); });
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxRequestsPerSocket = 100;
  const ready = new Promise((resolve, reject) => {
    server.once('listening', resolve); server.once('error', reject);
  });
  server.on('error', () => logger.error('[Portal] Private bridge unavailable; Discord playback continues.'));
  void ready.catch(() => {});
  server.listen(port, host); server.unref();
  let closeTask;
  const close = () => closeTask ||= (async () => {
    closing = true;
    // Release held change long polls before waiting for in-flight work.
    changes.close();
    // listen() can still be awaiting its callback when startup is interrupted.
    await ready.catch(() => {});
    if (server.listening) {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeIdleConnections?.();
      await withTimeout(Promise.allSettled([...work]), 2000).catch(() => {});
      for (const socket of sockets) socket.destroy();
      await closed;
    }
    revisions.close();
    policy.close();
    timings.close();
    server.removeAllListeners('connection'); server.removeAllListeners('clientError');
  })();
  return { enabled: true, server, ready, close, dispose: close };
}
