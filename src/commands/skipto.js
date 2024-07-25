import { player } from '../index.js';

export default function skipto(message, args) {
  const index = parseInt(args[0], 10);
  if (isNaN(index) || index < 1) {
    return message.reply('Please provide a valid song number to skip to.');
  }

  const queue = player.nodes.get(message.guild.id);
  if (!queue) return message.reply('There is no song playing!');

  if (index > queue.tracks.length) {
    return message.reply('The specified song number is out of range.');
  }

  queue.node.skipTo(index - 1); // Skip to the specified song (0-based index)
  message.reply(`Skipped to song number ${index}!`);
}
