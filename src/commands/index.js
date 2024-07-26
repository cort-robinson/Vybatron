import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v9';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const commands = [];
const commandMap = new Map();
const commandsPath = path.join(__dirname, '.');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js') && file !== 'index.js');

async function loadCommandsData() {
  for (const file of commandFiles) {
    const commandModule = await import(`./${file}`);
    const { data, execute } = commandModule;
    if (data && execute) {
      commands.push(data.toJSON());
      commandMap.set(data.name, execute);
    } else {
      console.warn(`Command file ${file} does not export data or execute`);
    }
  }
}

export async function loadCommands(client) {
  await loadCommandsData(); // Ensure commands are loaded before registering

  const clientId = process.env.CLIENT_ID;
  const token = process.env.DISCORD_BOT_TOKEN;

  const rest = new REST({ version: '9' }).setToken(token);

  try {
    console.log('Started refreshing global application (/) commands.');

    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands },
    );

    console.log('Successfully reloaded global application (/) commands.');

    // Fetch and log the registered commands
    const registeredCommands = await rest.get(
      Routes.applicationCommands(clientId)
    );

    console.log('Registered Commands:', registeredCommands);

  } catch (error) {
    console.error(error);
  }

  client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const commandName = interaction.commandName;
    const command = commandMap.get(commandName);

    if (!command) return;

    try {
      await command(interaction);
    } catch (error) {
      console.error(error);
      await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
    }
  });

  client.on('messageCreate', async message => {
    if (!message.guild || !message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();

    const command = commandMap.get(commandName);

    if (!command) {
      return message.reply('Unknown command');
    }

    try {
      // Create a mock interaction object to pass to the execute function
      const mockInteraction = {
        member: message.member,
        guild: message.guild,
        options: {
          getString: (name) => {
            const index = commandModule.data.options.findIndex(option => option.name === name);
            return args[index];
          },
          getInteger: (name) => {
            const index = commandModule.data.options.findIndex(option => option.name === name);
            return parseInt(args[index], 10);
          },
        },
        reply: (response) => message.reply(response),
        user: message.author,
        channel: message.channel,
      };

      await command(mockInteraction);
    } catch (error) {
      console.error(error);
      message.reply('There was an error while executing this command.');
    }
  });
}
