import { Client, GatewayIntentBits, ActivityType } from 'discord.js';
import { loadCommands } from './commands/index.js';
import { config, assertConfig } from './config.js';
import { initLavalink } from './lavalink.js';

assertConfig();

export const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

initLavalink(client);

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: '/play', type: ActivityType.Listening }],
    status: 'online',
  });
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
