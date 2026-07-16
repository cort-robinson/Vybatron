import { EmbedBuilder } from 'discord.js';
import { COLORS } from './messages.js';
import { safeText } from './presentation.js';

// Retained as a compatibility surface for SPEC §I. New interaction UI uses messages.js.
export function successEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(safeText(title, { maxLength: 256 }))
    .setDescription(safeText(description || '', { fallback: '', maxLength: 4096 }));
}

export function errorEmbed(message) {
  return new EmbedBuilder()
    .setColor(COLORS.error)
    .setTitle('Error')
    .setDescription(safeText(message, { maxLength: 4096 }));
}

export function infoEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(safeText(title, { maxLength: 256 }))
    .setDescription(safeText(description || '', { fallback: '', maxLength: 4096 }));
}

