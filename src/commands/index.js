import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleMessageComponent, handleModalSubmit } from '../utils/components.js';
import { errorPayload, SESSION_MIX_MODAL_ID } from '../utils/messages.js';
import { MessageFlags } from 'discord.js';
import { guardedMutation, commandMutationPolicy } from '../utils/requests.js';
import { publicError } from '../runtime.js';
import { handleAlertInteraction, isAlertInteraction } from '../operator-alerts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const commandMap = new Map();

export function friendlyInteractionError(error, context) {
  const details = [error?.code, error?.message, error?.cause?.message]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();

  if (/50013|50001|missing permissions|missing access/.test(details)) {
    return 'Vybatron is missing a Discord permission needed for that action. Check View Channel, Send Messages, Embed Links, Connect, and Speak permissions.';
  }
  if (/10062|40060|unknown interaction|already (?:been )?acknowledged/.test(details)) {
    return 'Discord didn’t accept that control in time. The player may already have updated; use Refresh before trying again.';
  }
  if (/no available nodes?|lavalink|econnrefused|connection refused|socket (?:closed|hang up)/.test(details)) {
    return 'The audio service is temporarily unavailable. Wait a moment, then try again.';
  }
  if (/took too long|timed out/.test(details)) return 'The audio source took too long to respond. Your queue is safe; try again in a moment.';
  if (/music queue is busy/.test(details)) return 'The music queue is busy. Wait a moment before trying again.';
  if (/listening session is stopping/.test(details)) return 'The listening session is stopping. Try /play again in a moment.';
  if (/queued music request was cancelled by stop/.test(details)) return 'Stop cancelled that waiting music request. Use /play to start a new session.';
  if (/favorites changed|mix changed/.test(details)) return 'The collection changed while saving. Refresh before trying again.';
  if (error?.name === 'AbortError') return 'That playback request was cancelled. Use /play to start a new session.';
  if (/queue holds at most|favorites hold at most|music library is full|name your mix|server can save/i.test(error?.message || '')) return error.message;
  if (/enospc|erofs|eacces|eperm|library/.test(details)) return 'The music library could not be saved. Playback still works; the server administrator should check the data volume.';
  if (context.startsWith('/play') && /youtube|spotify|soundcloud|load|search|track/.test(details)) {
    return 'That track couldn’t be loaded. Try another result or paste a direct YouTube, Spotify, or SoundCloud link.';
  }
  return `Vybatron hit an unexpected problem while handling ${context}. Try once more. If it keeps happening, share the reference below.`;
}

export async function loadCommandsData() {
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
  return commandMap;
}

async function reportInteractionError(interaction, error, context) {
  const referenceId = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  console.error(JSON.stringify({ event: 'interaction_failed', referenceId, context, error: publicError(error) }));

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
    // Alert DMs carry the only controls that work outside a server.
    if (isAlertInteraction(interaction)) {
      try { await handleAlertInteraction(interaction); } catch (error) { await reportInteractionError(interaction, error, 'audio alerts'); }
      return;
    }
    if (!interaction.guildId && !interaction.isAutocomplete()) {
      await interaction.reply({ content: 'Use Vybatron in a server with a voice channel.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
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
        const id = interaction.customId || '';
        const mutates = /^player:v1:(toggle|skip|shuffle|loop|stop-confirm)$/.test(id)
          || /^queue:v[12]:jump:/.test(id) || /^history:.*:replay:/.test(id)
          || /^player:v2:favorite:/.test(id) || /^import:v1:confirm:/.test(id);
        if (mutates) await guardedMutation(interaction, handleMessageComponent, { playback: !id.includes('favorite') && !id.startsWith('import:'), urgent: id === 'player:v1:stop-confirm' });
        else await handleMessageComponent(interaction);
      } catch (error) {
        await reportInteractionError(interaction, error, 'player controls');
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      try {
        // A session mix is a library write; seek changes playback.
        await guardedMutation(interaction, handleModalSubmit, { playback: interaction.customId !== SESSION_MIX_MODAL_ID });
      } catch (error) {
        await reportInteractionError(interaction, error, 'player controls');
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = commandMap.get(interaction.commandName);
    if (!command) return;

    try {
      const name = interaction.commandName;
      const action = interaction.options.getSubcommand?.(false);
      const policy = commandMutationPolicy(name, action);
      if (policy.readOnly) await command.execute(interaction);
      else await guardedMutation(interaction, command.execute, policy);
    } catch (error) {
      await reportInteractionError(interaction, error, `/${interaction.commandName}`);
    }
  });
}
