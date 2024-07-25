import { player } from '../index.js';

export default function skip(message) {
  const queue = player.nodes.get(message.guild.id);
  if (!queue) return message.reply('There is no song playing!');
  queue.node.skip();
  message.reply('Skipped the current song!');
}
