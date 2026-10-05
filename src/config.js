import dotenv from 'dotenv';
import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';

dotenv.config();

// Keep conversion separate from validation so malformed values fail with a
// credential-free setting name rather than appearing in logs or requests.
function integer(value, fallback) {
  if (value === undefined) return fallback;
  return /^\d+$/.test(String(value)) ? Number(value) : NaN;
}

export function readConfig(environment = process.env) {
  const nodeEnv = environment.NODE_ENV || 'development';
  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    token: environment.DISCORD_BOT_TOKEN,
    clientId: environment.CLIENT_ID,
    guildId: environment.GUILD_ID || null,
    dataDir: environment.VYBERTRON_DATA_DIR ?? resolve('data'),
    healthPort: integer(environment.VYBERTRON_HEALTH_PORT, 3000),
    shutdownTimeoutMs: integer(environment.VYBERTRON_SHUTDOWN_TIMEOUT_MS, 10_000),
    portalBridge: {
      token: environment.PORTAL_BRIDGE_TOKEN || null,
      host: environment.PORTAL_BRIDGE_HOST || '127.0.0.1',
      port: integer(environment.PORTAL_BRIDGE_PORT, 3010),
      operatorIds: (environment.PORTAL_OPERATOR_IDS || '').split(',').map(id => id.trim()).filter(Boolean),
    },
    lavalink: {
      host: environment.LAVALINK_HOST ?? 'localhost',
      port: integer(environment.LAVALINK_PORT, 2333),
      password: environment.LAVALINK_PASSWORD,
    },
  };
}

export const config = readConfig();

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${name} in environment`);
  if (/[\r\n\u0000]/.test(value)) throw new Error(`Invalid ${name} in environment`);
}

function boundedInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name} in environment`);
}

export function assertConfig(cfg = config) {
  required(cfg.token, 'DISCORD_BOT_TOKEN');
  required(cfg.clientId, 'CLIENT_ID');
  required(cfg.lavalink?.password, 'LAVALINK_PASSWORD');
  if (!/^\d{17,20}$/.test(cfg.clientId)) throw new Error('Invalid CLIENT_ID in environment');
  if (cfg.guildId && !/^\d{17,20}$/.test(cfg.guildId)) throw new Error('Invalid GUILD_ID in environment');
  const host = cfg.lavalink.host;
  if (typeof host !== 'string' || (!isIP(host) && !/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host))) {
    throw new Error('Invalid LAVALINK_HOST in environment');
  }
  boundedInteger(cfg.lavalink.port, 'LAVALINK_PORT', 1, 65535);
  if (cfg.nodeEnv !== undefined && !['development', 'test', 'production'].includes(cfg.nodeEnv)) throw new Error('Invalid NODE_ENV in environment');
  if (cfg.healthPort !== undefined) boundedInteger(cfg.healthPort, 'VYBERTRON_HEALTH_PORT', 1, 65535);
  if (cfg.shutdownTimeoutMs !== undefined) boundedInteger(cfg.shutdownTimeoutMs, 'VYBERTRON_SHUTDOWN_TIMEOUT_MS', 1000, 25000);
  if (cfg.dataDir !== undefined && (typeof cfg.dataDir !== 'string' || !isAbsolute(cfg.dataDir) || /[\r\n\u0000]/.test(cfg.dataDir))) {
    throw new Error('Invalid VYBERTRON_DATA_DIR in environment');
  }
  if (cfg.portalBridge?.token) {
    if (!/^[^\s\u0000]{32,512}$/.test(cfg.portalBridge.token)) throw new Error('Invalid PORTAL_BRIDGE_TOKEN in environment');
    boundedInteger(cfg.portalBridge.port, 'PORTAL_BRIDGE_PORT', 1, 65535);
    if (!isIP(cfg.portalBridge.host)) throw new Error('Invalid PORTAL_BRIDGE_HOST in environment');
    if (cfg.portalBridge.operatorIds.some(id => !/^\d{1,22}$/.test(id))) throw new Error('Invalid PORTAL_OPERATOR_IDS in environment');
  }
}
