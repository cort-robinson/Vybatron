import { GuildQueue, GuildQueueEvent, Track } from 'discord-player';
import { EmbedGenerator } from '../../utils/EmbedGenerator';
import type { PlayerEvent } from '../common/types';
import { PlayerMetadata } from '../PlayerMetadata';

export default class TrackFinishEvent
  implements PlayerEvent<typeof GuildQueueEvent.playerFinish>
{
  public name = GuildQueueEvent.playerFinish;

  public async execute(
    queue: GuildQueue<PlayerMetadata>,
    track: Track<unknown>
  ) {
    if (!queue.metadata?.channel) {
      console.error('No channel metadata found in queue');
      return;
    }

    const embed = EmbedGenerator.Success({
      description: `[${track.title}](${track.url})`,
      title: 'Track Finished!',
      thumbnail: { url: track.thumbnail },
      footer: {
        text: `Requested by ${track.requestedBy?.tag}`,
        iconURL: track.requestedBy?.displayAvatarURL(),
      },
    });

    queue.metadata.channel.send({ embeds: [embed] });
  }
}
