import { Player } from 'discord-player';
import { YoutubeiExtractor } from 'discord-player-youtubei';

export function createPlayer(client) {
  const player = new Player(client);

  player.extractors.loadDefault().then(() => {
    player.extractors.register(YoutubeiExtractor);
  });

  player.events.on('playerStart', (queue, track) => {
    queue.metadata.channel.send(`Started playing **${track.title}**!`);
  });

  player.events.on('error', (queue, error) => {
    queue.metadata.channel.send(`An error occurred: ${error.message}`);
    console.error(error);
  });

  return player;
}
