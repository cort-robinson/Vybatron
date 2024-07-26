import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v9';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Determine the environment
const isProduction = process.env.NODE_ENV === 'production';

const token = isProduction ? process.env.PROD_DISCORD_BOT_TOKEN : process.env.DEV_DISCORD_BOT_TOKEN;
const clientId = isProduction ? process.env.PROD_CLIENT_ID : process.env.DEV_CLIENT_ID;

const commands = [];
const commandsPath = path.join(__dirname, 'src', 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js') && file !== 'index.js');

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  console.log(`Loading command from file: ${file}`);
  try {
    const command = await import(filePath);
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

const rest = new REST({ version: '9' }).setToken(token);

(async () => {
  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    const data = await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands },
    );

    console.log(`Successfully reloaded ${data.length} application (/) commands.`);
  } catch (error) {
    console.error(`[ERROR] Failed to register commands:`, error);
  }
})();
