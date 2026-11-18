import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { mixVersion } from '../portal/selections.js';
import { requireUserVoice } from './guards.js';
import { loadCollection } from './library-actions.js';
import { ephemeralText } from './messages.js';
import { mixCover } from './music-art.js';
import { NO_MENTIONS, safeText } from './presentation.js';
import { guardedMutation } from './requests.js';

export async function mixtapeCard(name, mix, preview, artwork = mix.tracks) {
  const embed = new EmbedBuilder().setColor(0x8878de).setAuthor({ name: 'Session mixtape' })
    .setTitle(name).setDescription(mix.tracks.slice(0, 3).map((track, i) => `${i+1}. ${safeText(track.title, { maxLength: 90 })}`).join('\n'))
    .setFooter({ text: `${mix.tracks.length} ${mix.tracks.length === 1 ? 'track' : 'tracks'}` });
  const files = [];
  if (artwork) {
    const image = await mixCover(artwork);
    files.push({ attachment: image, name: 'mixtape.png', description: 'Four tiles from this mix’s artwork' });
    embed.setThumbnail('attachment://mixtape.png');
  }
  const button = new ButtonBuilder().setCustomId(`mixtape:${preview ? 'share' : 'queue'}:${mixVersion(mix)}:${name}`)
    .setLabel(preview ? 'Share to channel' : 'Queue this mix').setStyle(ButtonStyle.Primary);
  return { embeds: [embed], files, components: [new ActionRowBuilder().addComponents(button)], allowedMentions: NO_MENTIONS };
}

export async function handleMixtape(interaction, action, name, version) {
  const current = () => {
    const mixes = interaction.client.library.readGuild(interaction.guildId).mixes;
    return Object.hasOwn(mixes, name) && mixVersion(mixes[name]) === version ? mixes[name] : null;
  };
  const expired = () => interaction.reply(ephemeralText('That mix has changed or was deleted. Browse the current mixes with /mix list.'));
  if (!current()) return expired();
  if (action === 'queue') {
    return guardedMutation(interaction, async request => {
      const mix = current();
      if (!mix) return request.reply(ephemeralText('That mix has changed. Browse current mixes with /mix list.'));
      const channel = await requireUserVoice(request, { checkBotAccess: true });
      if (channel) return loadCollection(request, channel, mix.tracks, name);
    }, { playback: true, ordered: true });
  }
  const mayShare = () => interaction.message.flags?.has(MessageFlags.Ephemeral)
    && interaction.channel?.permissionsFor(interaction.member)?.has([P.ViewChannel, interaction.channel.isThread?.() ? P.SendMessagesInThreads : P.SendMessages]);
  if (!mayShare()) return interaction.reply(ephemeralText('You need permission to post in this channel to share the mix.'));
  await interaction.deferUpdate();
  const attach = interaction.appPermissions?.has(P.AttachFiles);
  const mix = current();
  if (!mix) return interaction.followUp(ephemeralText('The mix changed. Open your library to try again.'));
  const card = await mixtapeCard(name, mix, false, attach ? mix.tracks : null);
  if (!current() || !mayShare()) return interaction.followUp(ephemeralText('The mix or channel access changed. Open your library to try again.'));
  await interaction.channel.send({ ...card, nonce: interaction.message.id, enforceNonce: true });
  return interaction.editReply({ content: 'Mixtape shared to this channel.', components: [] });
}
