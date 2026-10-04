import { REST, Routes } from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from './src/config.js';

const root = path.dirname(fileURLToPath(import.meta.url));

export async function commandDefinitions(directory = path.join(root, 'src', 'commands')) {
  const files = (await fs.readdir(directory)).filter(file => file.endsWith('.js') && file !== 'index.js').sort();
  const commands = []; const names = new Set();
  for (const file of files) {
    const command = await import(pathToFileURL(path.join(directory, file)).href);
    if (!command.data || typeof command.execute !== 'function') throw new Error(`Command module ${file} is incomplete. Registration was cancelled.`);
    const definition = command.data.toJSON();
    if (names.has(definition.name)) throw new Error(`Duplicate command ${definition.name}. Registration was cancelled.`);
    names.add(definition.name);
    commands.push({ ...definition, dm_permission: false });
  }
  if (!commands.length) throw new Error('No commands were loaded. Registration was cancelled.');
  return commands;
}

export async function registerCommands({ mode = 'global', cfg = config, rest = null, definitions = commandDefinitions } = {}) {
  if (!['guild', 'global'].includes(mode)) throw new Error('Choose guild or global command registration.');
  if (!cfg.token || !cfg.clientId) throw new Error('DISCORD_BOT_TOKEN and CLIENT_ID are required for registration.');
  if (mode === 'guild' && !cfg.guildId) throw new Error('GUILD_ID is required for guild registration.');
  const body = await definitions();
  const api = rest || new REST({ version: '10', timeout: 15_000 }).setToken(cfg.token);
  const route = mode === 'guild' ? Routes.applicationGuildCommands(cfg.clientId, cfg.guildId) : Routes.applicationCommands(cfg.clientId);
  const result = await api.put(route, { body });
  console.log(`Registered ${result.length} ${mode} commands.`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await registerCommands({ mode: process.argv[2] || 'global' }); }
  catch (error) { console.error(`Command registration failed: ${error.message}`); process.exitCode = 1; }
}
