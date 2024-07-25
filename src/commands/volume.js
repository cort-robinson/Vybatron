import { player } from '../index.js';

export default function volume(message, args) {
  const volume = parseInt(args[0], 10);
  if (isNaN(volume) || volume < 0 || volume > 100) {
    return message.reply('Please provide a valid volume level between 0 and 100.');
  }
  const queue = player.nodes.get(message.guild.id);
  if (!queue) return message.reply('There is no song playing!');
  queue.node.setVolume(volume);
  message.reply(`Volume set to ${volume}%`);
}
