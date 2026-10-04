import { Client, GatewayIntentBits } from 'discord.js';
import { loadCommands } from './commands/index.js';
import { config, assertConfig } from './config.js';
import { initLavalink } from './lavalink.js';
import { startPresence } from './utils/presence.js';
import { startHealthServer } from './health.js';
import { installRuntime, logEvent } from './runtime.js';
import { initializeLibrary } from './utils/library.js';

assertConfig();

export const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

initLavalink(client);
const healthServer = startHealthServer(client, { port: config.healthPort });
let stopPresence = () => {};
const runtime = installRuntime(client, {
  server: healthServer,
  timeoutMs: config.shutdownTimeoutMs,
  stopPresence: () => stopPresence(),
});

client.once('clientReady', () => {
  void (async () => {
    if (client.runtimeState.draining) return;
    logEvent(console, 'info', 'discord_connected');
    stopPresence = startPresence(client);
    await client.lavalink.init({ id: client.user.id, username: client.user.username });
  })().catch((error) => runtime.fatal(error, 'audio_initialization_failed'));
});

async function init() {
  await initializeLibrary(client);
  await loadCommands(client);
  if (client.runtimeState.draining) return;
  await client.login(config.token);
}

void init().catch((error) => runtime.fatal(error, 'startup_failed'));
