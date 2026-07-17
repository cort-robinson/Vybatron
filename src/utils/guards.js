import { ephemeralText } from './messages.js';

async function reject(interaction, message) {
  const payload = ephemeralText(message);
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {}
  return null;
}

// V3: user must be in a voice channel.
export async function requireUserVoice(interaction, { checkBotAccess = false } = {}) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) return reject(interaction, 'Join a voice channel, then try again.');
  if (checkBotAccess && channel.joinable === false) {
    return reject(
      interaction,
      'Vybertron can’t join that voice channel. Check its View Channel and Connect permissions, and make sure the channel isn’t full.'
    );
  }
  if (checkBotAccess && channel.speakable === false) {
    return reject(
      interaction,
      'Vybertron can’t play audio in that voice channel. Grant it the Speak permission, then try again.'
    );
  }
  return channel;
}

// V8: control commands require an active player and the invoker in its voice channel.
export async function requireControl(interaction) {
  const channel = await requireUserVoice(interaction);
  if (!channel) return null;
  const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
  if (!player) return reject(interaction, 'Nothing is playing. Add something with /play.');
  if (player.voiceChannelId && player.voiceChannelId !== channel.id) {
    return reject(interaction, 'Join the bot’s voice channel to control playback.');
  }
  return player;
}
