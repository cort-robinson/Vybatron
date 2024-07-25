import { player } from '../index.js';

export default function stop(message) {
  const queue = player.nodes.get(message.guild.id);
  if (!queue) return message.reply('There is no song playing!');
  queue.delete();
  message.reply('Stopped the music and cleared the queue!');
}
