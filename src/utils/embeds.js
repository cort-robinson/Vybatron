import { EmbedBuilder } from 'discord.js';

const THEME_COLOR = 0x00ffd5; // Vybertron teal

export function successEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(THEME_COLOR)
    .setTitle(title)
    .setDescription(description || '')
    .setTimestamp();
}

export function errorEmbed(message) {
  return new EmbedBuilder()
    .setColor(0xff3860)
    .setTitle('Error')
    .setDescription(message)
    .setTimestamp();
}

export function infoEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0x7289da)
    .setTitle(title)
    .setDescription(description || '')
    .setTimestamp();
}


