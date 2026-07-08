import { errorEmbed } from './embeds.js';

async function reject(interaction, message) {
  const payload = { embeds: [errorEmbed(message)], ephemeral: true };
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {}
  return null;
}

// V3: user must be in a voice channel.
export async function requireUserVoice(interaction) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) return reject(interaction, 'Join a voice channel first.');
  return channel;
}

// V8: control commands require an active player and the invoker in its voice channel.
export async function requireControl(interaction) {
  const channel = await requireUserVoice(interaction);
  if (!channel) return null;
  const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
  if (!player) return reject(interaction, 'Nothing is playing.');
  if (player.voiceChannelId && player.voiceChannelId !== channel.id) {
    return reject(interaction, 'You must be in my voice channel to control playback.');
  }
  return player;
}
