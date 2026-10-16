import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
export const LIMITS = Object.freeze({
  sessions: 4096, pendingOAuth: 256, rateKeys: 2048, connections: 128,
  requests: 32, commandReaders: 4, stopRequests: 2,
  upstream: 8, stopUpstream: 1, bodyBytes: 16 * 1024,
  anonymousRequests: 1200, oauthStarts: 20,
  upstreamBytes: 4 * 1024 * 1024, snapshotBytes: 1024 * 1024,
  authFileBytes: 4 * 1024 * 1024, staticBytes: 16 * 1024 * 1024,
  urlBytes: 4096, headerBytes: 16 * 1024,
  requestMs: 10_000, upstreamMs: 10_000, commandMs: 90_000,
  // Device playback: the bot fetches a whole track before its first byte range.
  audioStreams: 4, audioMs: 60_000, audioBytes: 40 * 1024 * 1024,
  // pollMs is the safety net without the bot change feed; with a healthy feed
  // streams are woken on change and only poll for revocation every pollFeedMs.
  pollMs: 3000, pollFeedMs: 10_000, changesMs: 25_000, changesRetryMaxMs: 30_000,
  pollRetryMaxMs: 30_000, heartbeatMs: 10_000, drainMs: 5000,
  streams: 32, streamsPerSession: 2, streamLifetimeMs: 30 * 60_000,
  sessionMs: 7 * 24 * 60 * 60_000, oauthMs: 10 * 60_000,
});

export function isLoopback(host) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
}

function origin(value, name, production, allowPrivateHttp = false) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an origin`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || url.origin !== value) {
    throw new Error(`${name} must be an exact HTTP(S) origin without a trailing slash`);
  }
  if (!allowPrivateHttp && url.protocol !== 'https:' && (production || !isLoopback(url.hostname))) {
    throw new Error(`${name} requires HTTPS (HTTP is allowed only for local development)`);
  }
  return url.origin;
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  for (const name of ['PORTAL_BRIDGE_TOKEN', 'DISCORD_CLIENT_SECRET', 'PORTAL_SESSION_SECRET']) {
    if (typeof env[name] !== 'string' || env[name].length < 32 || env[name].length > 4096 || /[\r\n\0]/.test(env[name])) {
      throw new Error(`${name} must contain at least 32 characters of securely provisioned secret material`);
    }
  }
  if (!/^\d{1,20}$/.test(env.DISCORD_CLIENT_ID ?? '')) throw new Error('DISCORD_CLIENT_ID is required');
  const port = Number(env.PORTAL_PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORTAL_PORT must be a valid TCP port');
  const portalOrigin = origin(env.PORTAL_ORIGIN, 'PORTAL_ORIGIN', production);
  return Object.freeze({
    production, host: env.PORTAL_HOST || '127.0.0.1', port,
    origin: portalOrigin, callbackUrl: `${portalOrigin}/auth/discord/callback`,
    botUrl: origin(env.PORTAL_BOT_URL, 'PORTAL_BOT_URL', production, true),
    bridgeToken: env.PORTAL_BRIDGE_TOKEN, clientId: env.DISCORD_CLIENT_ID,
    clientSecret: env.DISCORD_CLIENT_SECRET, sessionSecret: env.PORTAL_SESSION_SECRET,
    dataDir: path.resolve(env.PORTAL_DATA_DIR || path.join(serverDir, 'data')),
    webDist: path.resolve(env.PORTAL_WEB_DIST || path.join(serverDir, '../web/dist')),
    discordAuthorizeUrl: 'https://discord.com/oauth2/authorize',
    discordTokenUrl: 'https://discord.com/api/oauth2/token',
    discordUserUrl: 'https://discord.com/api/v10/users/@me',
  });
}
