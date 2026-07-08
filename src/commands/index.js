import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { errorEmbed } from '../utils/embeds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const commandMap = new Map();

async function loadCommandsData() {
  const commandFiles = fs
    .readdirSync(__dirname)
    .filter((file) => file.endsWith('.js') && file !== 'index.js');

  for (const file of commandFiles) {
    const commandModule = await import(pathToFileURL(path.join(__dirname, file)).href);
    const { data, execute } = commandModule;
    if (data && execute) {
      commandMap.set(data.name, { execute, data });
    } else {
      console.warn(`Command file ${file} does not export data or execute`);
    }
  }
}

export async function loadCommands(client) {
  await loadCommandsData();

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commandMap.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(`Error in /${interaction.commandName}:`, error);
      const payload = {
        embeds: [errorEmbed('There was an error while executing this command.')],
        ephemeral: true,
      };
      try {
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch {}
    }
  });
}
