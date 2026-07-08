import dotenv from 'dotenv';

dotenv.config();

const env = process.env.NODE_ENV || 'development';

export const config = {
  nodeEnv: env,
  isProduction: env === 'production',
  token: process.env.DISCORD_BOT_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID || null,
  lavalink: {
    host: process.env.LAVALINK_HOST || 'localhost',
    port: Number(process.env.LAVALINK_PORT || 2333),
    password: process.env.LAVALINK_PASSWORD,
  },
};

export function assertConfig(cfg = config) {
  if (!cfg.token) throw new Error('Missing DISCORD_BOT_TOKEN in environment');
  if (!cfg.clientId) throw new Error('Missing CLIENT_ID in environment');
  if (!cfg.lavalink?.password) throw new Error('Missing LAVALINK_PASSWORD in environment');
}
