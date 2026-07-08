import dotenv from 'dotenv';

dotenv.config();

const env = process.env.NODE_ENV || 'development';

export const config = {
  nodeEnv: env,
  isProduction: env === 'production',
  token: process.env.DISCORD_BOT_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID || null,
};

export function assertConfig() {
  if (!config.token) throw new Error('Missing DISCORD_BOT_TOKEN in environment');
  if (!config.clientId) throw new Error('Missing CLIENT_ID in environment');
}


