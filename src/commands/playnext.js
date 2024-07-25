import { useQueue, useMainPlayer } from 'discord-player';

export default async function playnext(message, args) {
  const channel = message.member.voice.channel;
  if (!channel) return message.reply('You need to join a voice channel first!');
  const query = args.join(' ');

  try {
    const player = useMainPlayer();
    const queue = useQueue(message.guild.id);

    // Fetch the track information without playing it immediately
    const searchResult = await player.search(query, {
      requestedBy: message.author,
    });

    if (!searchResult || !searchResult.tracks.length) {
      return message.reply('No results found!');
    }

    const track = searchResult.tracks[0];

    if (queue) {
      // Insert the track at the second position in the queue (index 1)
      queue.insertTrack(track, 0);
      message.reply(`**${track.title}** will play next!`);
    } else {
      // Create a new queue and play the track immediately if no queue exists
      await player.play(channel, track.url, {
        nodeOptions: {
          metadata: message,
        },
      });
    }
  } catch (e) {
    message.reply(`Something went wrong: ${e.message}`);
  }
}
