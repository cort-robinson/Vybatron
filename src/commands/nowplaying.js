import { SlashCommandBuilder } from 'discord.js';
import { infoEmbed } from '../utils/embeds.js';

function formatMs(ms) {
  if (!Number.isFinite(ms)) return 'live';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export const data = new SlashCommandBuilder()
  .setName('nowplaying')
  .setDescription('Show the current track');

export async function execute(interaction) {
  const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
  const track = player?.queue?.current;
  if (!track) {
    return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
  }

  const position = formatMs(player.position);
  const duration = track.info.isStream ? 'live' : formatMs(track.info.duration);
  const embed = infoEmbed(
    'Now Playing',
    `**${track.info.title}**\nby ${track.info.author || 'Unknown'}\n\`${position} / ${duration}\``
  );
  if (track.info.uri) embed.setURL(track.info.uri);
  if (track.info.artworkUrl) embed.setThumbnail(track.info.artworkUrl);
  return interaction.reply({ embeds: [embed] });
}
