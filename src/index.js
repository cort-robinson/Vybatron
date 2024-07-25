import { Client, GatewayIntentBits } from 'discord.js';
import { loadCommands } from './commands/index.js';
import { createPlayer } from './player.js';
import dotenv from 'dotenv';

dotenv.config();

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

export const player = createPlayer(client);

loadCommands(client);

async function init() {
  await player.extractors.loadDefault();
  client.login(process.env.DISCORD_BOT_TOKEN);
}

init();
