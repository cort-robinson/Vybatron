import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleMessageComponent } from '../utils/components.js';
import { errorPayload } from '../utils/messages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const commandMap = new Map();

async function loadCommandsData() {
  const commandFiles = fs
    .readdirSync(__dirname)
    .filter((file) => file.endsWith('.js') && file !== 'index.js');

  for (const file of commandFiles) {
    const commandModule = await import(pathToFileURL(path.join(__dirname, file)).href);
    const { data, execute, autocomplete } = commandModule;
    if (data && execute) {
      commandMap.set(data.name, { execute, autocomplete, data });
    } else {
      console.warn(`Command file ${file} does not export data or execute`);
    }
  }
}

async function reportInteractionError(interaction, error, context) {
  const referenceId = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  console.error(`[${referenceId}] Error in ${context}:`, error);

  if (interaction.isAutocomplete()) {
    try { await interaction.respond([]); } catch {}
    return;
  }

  const payload = errorPayload(`Couldn’t complete ${context}. Try again.`, referenceId);
  try {
    if (interaction.isMessageComponent() && (interaction.deferred || interaction.replied)) {
      await interaction.followUp(payload);
    } else if (interaction.deferred) {
      const { flags, ...editPayload } = payload;
      await interaction.editReply(editPayload);
    } else if (interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch {}
}

export async function loadCommands(client) {
  await loadCommandsData();

  client.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) {
      const command = commandMap.get(interaction.commandName);
      if (!command?.autocomplete) {
        try { await interaction.respond([]); } catch {}
        return;
      }
      try {
        await command.autocomplete(interaction);
      } catch (error) {
        await reportInteractionError(interaction, error, `/${interaction.commandName} autocomplete`);
      }
      return;
    }

    if (interaction.isMessageComponent()) {
      try {
        await handleMessageComponent(interaction);
      } catch (error) {
        await reportInteractionError(interaction, error, 'player controls');
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = commandMap.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (error) {
      await reportInteractionError(interaction, error, `/${interaction.commandName}`);
    }
  });
}
