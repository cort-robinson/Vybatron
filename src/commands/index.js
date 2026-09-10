import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleMessageComponent, handleModalSubmit } from '../utils/components.js';
import { errorPayload } from '../utils/messages.js';
import { MessageFlags } from 'discord.js';
import { acquirePlaybackRequest } from '../utils/maintenance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const commandMap = new Map();

export function friendlyInteractionError(error, context) {
  const details = [error?.code, error?.message, error?.cause?.message]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();

  if (/50013|50001|missing permissions|missing access/.test(details)) {
    return 'Vybertron is missing a Discord permission needed for that action. Check View Channel, Send Messages, Embed Links, Connect, and Speak permissions.';
  }
  if (/10062|40060|unknown interaction|already (?:been )?acknowledged/.test(details)) {
    return 'Discord didn’t accept that control in time. The player may already have updated; use Refresh before trying again.';
  }
  if (/no available nodes?|lavalink|econnrefused|connection refused|socket (?:closed|hang up)/.test(details)) {
    return 'The audio service is temporarily unavailable. Wait a moment, then try again.';
  }
  if (context.startsWith('/play') && /youtube|spotify|soundcloud|load|search|track/.test(details)) {
    return 'That track couldn’t be loaded. Try another result or paste a direct YouTube, Spotify, or SoundCloud link.';
  }
  return `Vybertron hit an unexpected problem while handling ${context}. Try once more. If it keeps happening, share the reference below.`;
}

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

  const payload = errorPayload(friendlyInteractionError(error, context), referenceId);
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

    if (interaction.isModalSubmit()) {
      try {
        await handleModalSubmit(interaction);
      } catch (error) {
        await reportInteractionError(interaction, error, 'player controls');
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = commandMap.get(interaction.commandName);
    if (!command) return;

    let release;
    try {
      if (['play', 'playnext'].includes(interaction.commandName)) {
        release = acquirePlaybackRequest(client);
        if (!release) {
          await interaction.reply({ content: 'Vybertron is briefly updating its playback service. Try again in a minute.', flags: MessageFlags.Ephemeral });
          return;
        }
      }
      await command.execute(interaction);
    } catch (error) {
      await reportInteractionError(interaction, error, `/${interaction.commandName}`);
    } finally {
      release?.();
    }
  });
}
