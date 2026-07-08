import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { config, assertConfig } from './src/config.js';

assertConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const commands = [];
const commandsPath = path.join(__dirname, 'src', 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js') && file !== 'index.js');

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  console.log(`Loading command from file: ${file}`);
  try {
    const command = await import(pathToFileURL(filePath).href);
    if ('data' in command && 'execute' in command) {
      commands.push(command.data.toJSON());
      console.log(`Successfully loaded command: ${command.data.name}`);
    } else {
      console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
    }
  } catch (error) {
    console.error(`[ERROR] Failed to load command at ${filePath}:`, error);
  }
}

const rest = new REST({ version: '10' }).setToken(config.token);

const registerGlobal = async () => {
  console.log(`Refreshing ${commands.length} global application (/) commands...`);
  const data = await rest.put(
    Routes.applicationCommands(config.clientId),
    { body: commands }
  );
  console.log(`Registered ${data.length} global application (/) commands.`);
};

const registerGuild = async () => {
  if (!config.guildId) throw new Error('GUILD_ID is required for guild registration');
  console.log(`Refreshing ${commands.length} guild application (/) commands for guild ${config.guildId}...`);
  const data = await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body: commands }
  );
  console.log(`Registered ${data.length} guild application (/) commands.`);
};

const mode = process.argv[2];
if (mode === 'guild') {
  registerGuild().catch(console.error);
} else {
  registerGlobal().catch(console.error);
}
