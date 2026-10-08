import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { ephemeralText } from '../utils/messages.js';
import { voteToSkip } from '../utils/voting.js';

export const data = new SlashCommandBuilder().setName('voteskip').setDescription('Vote to skip the current song; a majority of listeners decides');
export async function execute(interaction) {
  const player = await requireControl(interaction, { checkDJ: false }); if (!player) return;
  const channel = interaction.member.voice.channel;
  const humans = [...channel.members.values()].filter(member => !member.user.bot).map(member => member.id);
  const result = await voteToSkip(player, interaction.user.id, humans, interaction.client);
  return interaction.reply(ephemeralText(result.error || (result.passed ? `Vote passed (${result.count}/${result.needed}). Skipped the song.` : `${result.duplicate ? 'You already voted.' : 'Vote added.'} ${result.count}/${result.needed} votes to skip. Bots and listeners who left do not count.`)));
}
