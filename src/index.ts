import { client } from './bootstrap/client';
import { Player } from 'discord-player';
// import { fetch, setGlobalDispatcher, Agent } from 'undici';
import { DiscordPlayerOptions } from './utils/constants';
import { registerPlayerEvents } from './player/registerEvents';
// import { YoutubeiExtractor } from 'discord-player-youtubei';

// setGlobalDispatcher(new Agent({ connect: { timeout: 60_000 } }));

const player = new Player(client, {
  ytdlOptions: {
    headers: {
      cookie: process.env.YOUTUBE_COOKIE,
    }
  }
});

if (process.env.NODE_ENV !== 'production') {
  player.on('debug', (message) => console.log(`[Player] ${message}`));
  player.events.on('debug', (queue, message) =>
    console.log(`[${queue.guild.name}: ${queue.guild.id}] ${message}`)
  );
}

await registerPlayerEvents();

await player.extractors.loadDefault((ext) => {
  return !DiscordPlayerOptions.disableSources.includes(ext);
}, DiscordPlayerOptions.extractorConfig);

// player.extractors.register(YoutubeiExtractor, {
//   authentication: "access_token=ya29.a0AcM612yUjn02rztnolTDzUryb3a8OfwTPk-sjbqyFxcejTfwD0RRTd0awV9zY07QdRJP-j6hYJM_UuhuajuZe5lFYmHxxeFeWc4-RD4saLwutrfyOwSHcJffPVmPoxwVXa0IQRvohtg0zrXJHzLUUpJw4UQguarSlKtHBnlaj-bSlB2haCgYKAacSARESFQHGX2MiyZdWRUqwKHHd8nbv8pzLcg0183; refresh_token=1//0fl_WfTk8SjmwCgYIARAAGA8SNwF-L9Ir8jjVGb5_qsa8dL_F2W-Wvn7KTkMaVGXzTpgWlxQ60ewAbltXI0xRtAMVarIiMjIO0K8; scope=https://www.googleapis.com/auth/youtube-paid-content https://www.googleapis.com/auth/youtube; token_type=Bearer; expiry_date=2024-08-05T04:26:42.946Z"
// });

// player.events.on('playerStart', (queue, track) => {
//   console.log(`Started playing **${track.title}**`);
// });

// player.events.on('playerError', (queue, error) => {
//   console.error(`Player error event: ${error.message}`);
// });

// player.events.on('error', (queue, error) => {
//   console.log(`General player error event: ${error.message}`);
//   console.log(error);
// });

// player.events.on('audioTrackAdd', (queue, track) => {
//   console.log(`Audio track added: **${track.title}**`);
// });

// player.events.on('audioTracksAdd', (queue, tracks) => {
//   console.log(`Multiple audio tracks added: **${tracks.length}** tracks`);
// });

await client.login(process.env.DISCORD_TOKEN);

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});
