import http from 'node:http';
import https from 'node:https';
import { HttpError, busy, unavailable, unauthorized } from './security.js';

const safeErrors = {
  400: ['invalid_input', 'The bot rejected this input. Refresh and check the command options.'],
  401: ['unauthenticated', 'Sign in with Discord to continue.'],
  403: ['forbidden', 'Your current Discord permissions or voice state do not allow this action.'],
  404: ['not_found', 'This guild or resource is unavailable to you.'],
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
    const options = { keepAlive: true, maxSockets: limits.upstream, maxFreeSockets: Math.min(4, limits.upstream) };
    this.httpAgent = new http.Agent(options); this.httpsAgent = new https.Agent(options);
  }

  async request(url, { method = 'GET', headers = {}, body, signal, timeout = this.limits.upstreamMs, stop = false } = {}) {
    if (this.active >= this.limits.upstream || (stop && this.stopCapacity > 0
      ? this.stops >= this.stopCapacity : this.ordinary >= this.limits.upstream - this.stopCapacity)) throw busy();
    this.active++; if (stop && this.stopCapacity > 0) this.stops++; else this.ordinary++;
    try {
      return await new Promise((resolve, reject) => {
        const target = new URL(url); const secure = target.protocol === 'https:';
        const req = (secure ? https : http).request(target, {
          method, headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', ...headers,
            ...(body !== undefined && { 'Content-Length': Buffer.byteLength(body) }) },
          agent: secure ? this.httpsAgent : this.httpAgent, signal, maxHeaderSize: this.limits.headerBytes,
        }, response => {
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
              resolve({ status: response.statusCode, data });
            } catch { reject(new InvalidUpstreamResponse()); }
          });
        });
        const timer = setTimeout(() => req.destroy(new Error('Upstream timeout')), timeout); timer.unref();
        req.once('close', () => clearTimeout(timer));
        req.once('error', () => reject(unavailable()));
        req.end(body);
      });
    } finally { this.active--; if (stop && this.stopCapacity > 0) this.stops--; else this.ordinary--; }
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

  async bridge(endpoint, actorId, { query = {}, command, signal, shareRead = false } = {}) {
    const url = new URL(endpoint, this.config.botUrl);
    if (actorId && !command) url.searchParams.set('actorId', actorId);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const options = {
      headers: { Authorization: `Bearer ${this.config.bridgeToken}`, ...(command && { 'Content-Type': 'application/json' }) },
      method: command ? 'POST' : 'GET', body: command ? JSON.stringify({ actorId, ...command }) : undefined,
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
  }
}
