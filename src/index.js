import { Client, GatewayIntentBits } from 'discord.js';
import { loadCommands } from './commands/index.js';
import { config, assertConfig } from './config.js';
import { initLavalink } from './lavalink.js';
import { startPresence } from './utils/presence.js';
import { startHealthServer } from './health.js';

assertConfig();

export const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

initLavalink(client);
startHealthServer(client);

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  startPresence(client);
  client.lavalink.init({ id: client.user.id, username: client.user.username });
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

async function init() {
  await loadCommands(client);
  await client.login(config.token);
}

init();
