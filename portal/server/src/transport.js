import http from 'node:http';
import https from 'node:https';
import { HttpError, busy, unavailable, unauthorized } from './security.js';

const safeErrors = {
  400: ['invalid_input', 'The bot rejected this input. Refresh and check the command options.'],
  401: ['unauthenticated', 'Sign in with Discord to continue.'],
  403: ['forbidden', 'Your current Discord permissions or voice state do not allow this action.'],
  404: ['not_found', 'This guild or resource is unavailable to you.'],
  413: ['audio_too_long', 'This song is too long to play on this device.'],
  409: ['stale_revision', 'The session changed. Refresh before retrying this action.'],
  429: ['busy', 'The bot is busy. Please try again shortly.'],
  503: ['unavailable', 'The bot or audio service is unavailable. Refresh before making another change.'],
};

// Keep rejected response payloads distinct from socket/deadline outages without
// exposing private upstream fields or changing the public safe error contract.
class InvalidUpstreamResponse extends HttpError {
  constructor() {
    const safe = unavailable();
    super(safe.status, safe.code, safe.message);
  }
}

export const isRetryableReadError = error => error instanceof HttpError &&
  !(error instanceof InvalidUpstreamResponse) && [429, 503].includes(error.status);

// The bot's change-feed position for a snapshot read or command, kept beside
// the parsed body so the body itself (forwarded to browsers) never carries it.
const cursors = new WeakMap();
export const changeCursor = data => (data && typeof data === 'object' && cursors.get(data)) || null;
function parseCursor(value) {
  const match = typeof value === 'string' && /^([0-9a-f-]{36}):(\d{1,15})$/.exec(value);
  return match ? { instance: match[1], sequence: Number(match[2]) } : null;
}
// The bot keeps idle bridge sockets for five seconds. Retiring them a second
// sooner means a request never lands on a socket the bot is closing.
const IDLE_SOCKET_MS = 4000;

export class Transport {
  constructor(config, limits) {
    this.config = config; this.limits = limits; this.active = 0; this.ordinary = 0; this.stops = 0;
    this.sharedReads = new Map();
    // One slot remains available to Stop even when every ordinary slot is busy.
    // Tiny nonproduction test pools retain one ordinary slot as well.
    this.stopCapacity = Math.min(limits.stopUpstream, Math.max(0, limits.upstream - 1));
    // A shared maxTotalSockets can deadlock a one-slot pool when an idle Discord
    // connection occupies the slot needed by the bridge. Active requests are
    // capped above, and each of the fixed upstream origins retains at most four.
    const options = { keepAlive: true, maxSockets: limits.upstream, maxFreeSockets: Math.min(4, limits.upstream), timeout: IDLE_SOCKET_MS };
    this.httpAgent = new http.Agent(options); this.httpsAgent = new https.Agent(options);
    // The held change long poll gets its own single socket so it never waits
    // behind, or occupies, the bounded protected-request pool.
    const feed = { keepAlive: true, maxSockets: 1, maxFreeSockets: 1, timeout: IDLE_SOCKET_MS };
    this.feedAgents = { http: new http.Agent(feed), https: new https.Agent(feed) };
    // Audio streams to a phone for as long as its connection takes, so it has
    // its own small pool and never holds the protected-request slots.
    this.audioActive = 0;
    this.audioAgent = new http.Agent({ keepAlive: true, maxSockets: limits.audioStreams, maxFreeSockets: 2, timeout: IDLE_SOCKET_MS });
  }

  // Passes one audio byte range from the bot straight to the browser. Only an
  // audio body with a sane length and range is forwarded; errors stay sanitized.
  async audio(endpoint, actorId, { range, signal, res }) {
    if (this.audioActive >= this.limits.audioStreams) throw busy();
    this.audioActive++;
    try {
      await new Promise((resolve, reject) => {
        const url = new URL(endpoint, this.config.botUrl); url.searchParams.set('actorId', actorId);
        const req = (url.protocol === 'https:' ? https : http).request(url, {
          headers: { Authorization: `Bearer ${this.config.bridgeToken}`, 'Accept-Encoding': 'identity', ...(range && { Range: range }) },
          agent: url.protocol === 'https:' ? this.httpsAgent : this.audioAgent, signal, maxHeaderSize: this.limits.headerBytes,
        }, response => {
          clearTimeout(timer);
          const status = response.statusCode; const type = response.headers['content-type'] || '';
          const length = Number(response.headers['content-length']); const contentRange = response.headers['content-range'];
          const validRange = value => typeof value === 'string' && /^bytes (\d+-\d+|\*)\/\d+$/.test(value);
          if (status === 416 && validRange(contentRange)) { response.resume(); res.writeHead(416, { 'Content-Range': contentRange }); res.end(); resolve(); return; }
          // A song still arriving streams without a length; its bytes are counted instead.
          const unsized = status === 200 && response.headers['content-length'] === undefined && response.headers['transfer-encoding'] === 'chunked';
          if ([200, 206].includes(status) && /^audio\/(ogg|mp4|webm)$/.test(type) && (unsized || (Number.isSafeInteger(length) && length <= this.limits.audioBytes))
            && (status === 200 || validRange(contentRange))) {
            res.writeHead(status, { 'Content-Type': type, ...(!unsized && { 'Content-Length': length }), 'Accept-Ranges': 'bytes', ...(status === 206 && { 'Content-Range': contentRange }) });
            let sent = 0;
            response.on('data', chunk => { sent += chunk.length; if (sent > this.limits.audioBytes) { res.destroy(); req.destroy(); } });
            response.pipe(res);
            response.once('end', resolve); response.once('error', () => { res.destroy(); resolve(); });
            res.once('close', () => { req.destroy(); resolve(); });
            return;
          }
          response.resume();
          const [code, message] = status !== 200 && safeErrors[status] || safeErrors[503];
          reject(new HttpError(status !== 200 && safeErrors[status] ? status : 503, code, message));
        });
        const timer = setTimeout(() => req.destroy(new Error('Upstream timeout')), this.limits.audioMs); timer.unref();
        req.once('error', () => { clearTimeout(timer); reject(unavailable()); });
        req.end();
      });
    } finally { this.audioActive--; }
  }

  async request(url, { method = 'GET', headers = {}, body, signal, timeout = this.limits.upstreamMs, stop = false } = {}) {
    if (this.active >= this.limits.upstream || (stop && this.stopCapacity > 0
      ? this.stops >= this.stopCapacity : this.ordinary >= this.limits.upstream - this.stopCapacity)) throw busy();
    this.active++; if (stop && this.stopCapacity > 0) this.stops++; else this.ordinary++;
    try {
      return await this.send(url, { method, headers, body, signal, timeout });
    } finally { this.active--; if (stop && this.stopCapacity > 0) this.stops--; else this.ordinary--; }
  }

  send(url, { method = 'GET', headers = {}, body, signal, timeout = this.limits.upstreamMs, feed = false, retried = false } = {}) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const target = new URL(url); const secure = target.protocol === 'https:'; let responded = false;
      const agent = feed ? this.feedAgents[secure ? 'https' : 'http'] : secure ? this.httpsAgent : this.httpAgent;
      const req = (secure ? https : http).request(target, {
        method, headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', ...headers,
          ...(body !== undefined && { 'Content-Length': Buffer.byteLength(body) }) },
        agent, signal, maxHeaderSize: this.limits.headerBytes,
      }, response => {
        responded = true;
        let size = 0; const chunks = [];
        // Settle the terminal validation error before destroying the socket:
        // the resulting transport error must not replace its classification.
        const fail = () => { reject(new InvalidUpstreamResponse()); response.destroy(); req.destroy(); };
        const length = Number(response.headers['content-length']);
        if (length > this.limits.upstreamBytes || response.headers['content-encoding'] ||
            !/^application\/json(?:\s*;.*)?$/i.test(response.headers['content-type'] || '')) { fail(); return; }
        response.on('data', chunk => { size += chunk.length; if (size > this.limits.upstreamBytes) fail(); else chunks.push(chunk); });
        response.on('error', () => reject(unavailable()));
        response.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
            const cursor = parseCursor(response.headers['x-change-cursor']);
            if (cursor) cursors.set(data, cursor);
            resolve({ status: response.statusCode, data });
          } catch { reject(new InvalidUpstreamResponse()); }
        });
      });
      const timer = setTimeout(() => req.destroy(new Error('Upstream timeout')), timeout); timer.unref();
      req.once('close', () => clearTimeout(timer));
      req.once('error', error => {
        // A kept-alive socket can still close as a request reuses it. Only a
        // read that got no response may go again, once, within its deadline.
        // Commands and other writes are never resent.
        const remaining = timeout - (Date.now() - started);
        if (!retried && method === 'GET' && req.reusedSocket && !responded && !signal?.aborted && remaining > 0
          && ['ECONNRESET', 'EPIPE'].includes(error?.code)) {
          clearTimeout(timer);
          resolve(this.send(url, { method, headers, body, signal, timeout: remaining, feed, retried: true }));
          return;
        }
        reject(unavailable());
      });
      req.end(body);
    });
  }

  // Private wake-up cursor from the bot. It returns guild IDs only; streams
  // still perform their own fresh authorized reads after being woken.
  async changes(instance, after, signal) {
    const url = new URL('/v1/changes', this.config.botUrl);
    url.searchParams.set('instance', instance); url.searchParams.set('after', String(after));
    const result = await this.send(url, { headers: { Authorization: `Bearer ${this.config.bridgeToken}` }, signal, timeout: this.limits.changesMs, feed: true });
    const data = result.data;
    if (result.status !== 200 || typeof data.instanceId !== 'string' || data.instanceId.length > 64 || !Number.isSafeInteger(data.sequence) || data.sequence < 0
      || typeof data.reset !== 'boolean' || !Array.isArray(data.guildIds) || data.guildIds.length > 256
      || !data.guildIds.every(id => typeof id === 'string' && /^\d{1,20}$/.test(id))) throw new InvalidUpstreamResponse();
    // Each guild's newest entry; an older bot sends only the overall sequence.
    const sequences = Array.isArray(data.sequences) && data.sequences.length === data.guildIds.length
      && data.sequences.every(value => Number.isSafeInteger(value) && value >= 0 && value <= data.sequence) ? data.sequences : undefined;
    return { instanceId: data.instanceId, sequence: data.sequence, reset: data.reset, guildIds: data.guildIds, ...(sequences && { sequences }) };
  }

  sharedRead(url, options, signal) {
    if (signal?.aborted) return Promise.reject(unavailable());
    const key = url.href;
    let pending = this.sharedReads.get(key);
    if (!pending) {
      const controller = new AbortController();
      pending = { controller, subscribers: new Set(), settled: false, promise: null };
      this.sharedReads.set(key, pending);
      pending.promise = this.request(url, { ...options, signal: controller.signal }).finally(() => {
        pending.settled = true;
        if (this.sharedReads.get(key) === pending) this.sharedReads.delete(key);
      });
    }
    // Share only an overlapping SSE read for the identical trusted actor/guild.
    // Successful permission decisions are never cached. Ordinary GETs stay
    // independent so a post-command refresh cannot join a pre-command read.
    return new Promise((resolve, reject) => {
      const subscriber = {}; pending.subscribers.add(subscriber);
      let finished = false;
      const finish = (error, value) => {
        if (finished) return; finished = true;
        signal?.removeEventListener('abort', onAbort); pending.subscribers.delete(subscriber);
        if (!pending.settled && pending.subscribers.size === 0) {
          if (this.sharedReads.get(key) === pending) this.sharedReads.delete(key);
          pending.controller.abort();
        }
        if (error) reject(error); else resolve(value);
      };
      const onAbort = () => finish(unavailable());
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.promise.then(value => finish(null, value), error => finish(error));
      if (signal?.aborted) onAbort();
    });
  }

  fenceSharedReads(endpoint) {
    const target = new URL(endpoint, this.config.botUrl);
    // Existing subscribers finish normally, but a post-command verification
    // must not join authorization/state captured before that command completed.
    // This retains no snapshot or permission result and does not cancel readers.
    for (const key of this.sharedReads.keys()) {
      const url = new URL(key);
      if (url.origin === target.origin && url.pathname === target.pathname) this.sharedReads.delete(key);
    }
  }

  async bridge(endpoint, actorId, { query = {}, command, signal, shareRead = false, method = 'GET' } = {}) {
    const url = new URL(endpoint, this.config.botUrl);
    if (actorId && !command) url.searchParams.set('actorId', actorId);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const options = {
      headers: { Authorization: `Bearer ${this.config.bridgeToken}`, ...(command && { 'Content-Type': 'application/json' }) },
      // A bodiless POST still sends an explicit zero length.
      method: command ? 'POST' : method, body: command ? JSON.stringify({ actorId, ...command }) : method === 'POST' ? '' : undefined,
      timeout: command ? this.limits.commandMs : this.limits.upstreamMs,
      stop: command?.command === 'stop',
    };
    const result = shareRead && !command ? await this.sharedRead(url, options, signal) : await this.request(url, { ...options, signal });
    if (result.status !== 200) {
      // Only this exact private bridge code is a terminal projection failure.
      // All other upstream codes/messages remain ignored and sanitized by status.
      if (result.status === 503 && result.data.error?.code === 'projection_limit') throw new InvalidUpstreamResponse();
      const [code, message] = safeErrors[result.status] || safeErrors[503];
      throw new HttpError(safeErrors[result.status] ? result.status : 503, code, message);
    }
    return result.data;
  }

  async discordIdentity(code, signal) {
    const body = new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret,
      grant_type: 'authorization_code', redirect_uri: this.config.callbackUrl, code }).toString();
    const token = await this.request(this.config.discordTokenUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal,
    });
    if (token.status === 400 || token.status === 401) throw unauthorized();
    if (token.status !== 200 || token.data.token_type?.toLowerCase() !== 'bearer' ||
        typeof token.data.access_token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token.data.access_token) ||
        !String(token.data.scope || '').split(' ').includes('identify')) throw unavailable();
    const user = await this.request(this.config.discordUserUrl, { headers: { Authorization: `Bearer ${token.data.access_token}` }, signal });
    if (user.status === 401 || user.status === 403) throw unauthorized();
    if (user.status !== 200 || typeof user.data.id !== 'string' || !/^\d{1,20}$/.test(user.data.id) || user.data.bot) throw unavailable();
    // OAuth access/refresh tokens are never persisted or returned to the browser.
    return user.data.id;
  }

  close() {
    for (const pending of this.sharedReads.values()) pending.controller.abort();
    this.sharedReads.clear(); this.httpAgent.destroy(); this.httpsAgent.destroy();
    this.feedAgents.http.destroy(); this.feedAgents.https.destroy();
  }
}
