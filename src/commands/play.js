import { player } from '../index.js';

export default async function play(message, args) {
  const channel = message.member.voice.channel;
  if (!channel) return message.reply('You need to join a voice channel first!');
  const query = args.join(' ');

  try {
    const { track } = await player.play(channel, query, {
      nodeOptions: {
        metadata: message,
      },
    });

    message.reply(`**${track.title}** enqueued!`);
  } catch (e) {
    message.reply(`Something went wrong: ${e.message}`);
  }
}
