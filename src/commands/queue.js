import { player } from '../index.js';

export default function queue(message) {
  const queue = player.nodes.get(message.guild.id);
  if (!queue) return message.reply('There are no songs in the queue!');
  const tracks = queue.tracks.map((track, i) => `${i + 1}. ${track.title}`).join('\n');
  message.reply(`**Current Queue:**\n${tracks}`);
}
