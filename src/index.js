import { Client, GatewayIntentBits } from 'discord.js';
import { loadCommands } from './commands/index.js';
import { createPlayer } from './player.js';
import dotenv from 'dotenv';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

const token = isProduction ? process.env.PROD_DISCORD_BOT_TOKEN : process.env.DEV_DISCORD_BOT_TOKEN;

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

export const player = createPlayer(client);

async function init() {
  await player.extractors.loadDefault();
  await loadCommands(client);
  client.login(token);
}

init();
