import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { NO_MENTIONS, safeText } from './presentation.js';

export const HELP_TOPICS = Object.freeze([
  { label: 'Get started', value: 'start', description: 'Play music and use the shared controller' },
  { label: 'Playback & queue', value: 'controls', description: 'Transport, queue tools, and audio presets' },
  { label: 'Your music', value: 'library', description: 'Favorites, shared mixes, history, and discovery' },
  { label: 'Sources & troubleshooting', value: 'sources', description: 'Source capabilities and recovery guidance' },
]);

function sourceDescription(client) {
  const nodes = [...(client?.lavalink?.nodeManager?.nodes?.values?.() || [])];
  const sources = [...new Set(nodes.filter((node) => node.connected === true)
    .flatMap((node) => Array.isArray(node.info?.sourceManagers) ? node.info.sourceManagers : []))];
  return sources.length
    ? `The connected audio servers report: ${sources.slice(0, 12).map((source) => safeText(source, { maxLength: 40 })).join(', ')}.`
    : 'Source availability is reported when the audio server connects. If playback is unavailable, wait a moment and try again.';
}

// inviteUrl is passed only to people allowed to add the bot (see invite.js).
export function buildHelpPayload(client, requestedTopic = 'start', ownerId = 'any', { inviteUrl = null } = {}) {
  const topic = HELP_TOPICS.find((entry) => entry.value === requestedTopic) || HELP_TOPICS[0];
  const embed = new EmbedBuilder().setColor(0x00c8ff).setTitle(`Vybatron v2 • ${topic.label}`);
  if (topic.value === 'start') {
    embed.setDescription('Your voice channel, your soundtrack. Join a voice channel, then use `/play` with a song name or supported track/playlist link.')
      .addFields(
        { name: 'Make it yours', value: '`/play` adds music. `/playnext` puts it next. `/nowplaying` shows the track and links to the shared player. `/lyrics` shows its lyrics, only to you.' },
        { name: 'One player, less noise', value: 'Use the player’s Pause, Skip, Queue, Seek, and Favorite controls. It updates in place as music changes. Refresh updates its progress snapshot.' },
        { name: 'A good next move', value: 'Save a favorite with `/favorite add`, browse `/history`, or set `/filter preset:Warm` for a softer sound.' },
        { name: 'Shared listening', value: 'Join the bot’s voice channel to change playback. A configured DJ role can limit shared controls; listeners can still use `/voteskip`.' },
      );
    if (inviteUrl) embed.addFields({ name: 'Bring it to another server', value: '`/invite` or the button below adds Vybatron to a server where you have Manage Server permission. Only you can see this.' });
  } else if (topic.value === 'controls') {
    embed.setDescription('Playback controls are shared by everyone in the bot’s voice channel. A configured DJ role may restrict changes.')
      .addFields(
        { name: 'Playback', value: '`/pause` · `/resume` · `/back` · `/skip` · `/voteskip` · `/stop`\n`/back` returns to the previous track, or restarts this one after a few seconds.\n`/seek timestamp:1:30` jumps within a seekable track.' },
        { name: 'Build the queue', value: '`/queue` browses upcoming tracks. `/move`, `/remove`, and `/skipto` use queue positions. `/shuffle` rearranges upcoming tracks; `/loop` repeats a track or the queue.' },
        { name: 'Tune the sound', value: '`/volume` sets 0–100%. `/filter` shows the current preset. Choose Original, Bass, Warm, Clarity, Nightcore, Slow, or Mono; every preset replaces previous effects.' },
        { name: 'Sleep timer', value: '`/sleep in minutes:30` stops playback after 1–720 minutes. `/sleep after-track` stops when the current track ends, before the next song or an autoplay pick. `/sleep show` and `/sleep cancel` check or clear it. It ends like Stop and is cleared if the session ends first.' },
        { name: 'Go back without losing your place', value: '`/history` browses recent session tracks. `/replay position:1` queues the most recent track next and lets the current song finish.' },
      );
  } else if (topic.value === 'library') {
    embed.setDescription('Save what you love, bring a shared mix back, and choose when to discover something new.')
      .addFields(
        { name: 'Personal favorites', value: '`/favorite add` saves the current track. `/favorite import` adds a public playlist after a preview. Use `/favorite list`, `/favorite play`, `/favorite remove`, or `/favorite clear` to manage your library.' },
        { name: 'Shared guild mixes', value: '`/mix save` captures the current track and queue. `/mix list` finds saved mixes; `/mix load` brings one back. `/mix import` adds a public playlist to a mix. `/mix delete` removes one.' },
        { name: 'Server favorites', value: '`/top show` lists what this server has on repeat, or its forgotten gems. `/top play` queues either list, optionally shuffled.' },
        { name: 'Made for you', value: '`/mymix play` queues Your mix (new picks every Monday), your top tracks, Rediscover, or an artist mix. `/mix save session:true` keeps this session as a shared mix.' },
        { name: 'Keep the music going', value: '`/radio on` plays related songs after your queue runs out; add a song or link to start from it. Songs people queue always play first. `/radio promote`, `/radio remove`, and `/radio less` manage suggestions; `/radio off` stops for this session.' },
        { name: 'Pick up later', value: '`/session show` inspects a saved session; `/session resume` restores it in your voice channel. `/session discard` clears it.' },
        { name: 'Make this server feel right', value: '`/settings show` displays guild defaults. Configure volume, fair queue, autoplay, and the DJ role with `/settings`; `/settings reset` restores defaults.' },
      );
  } else {
    embed.setDescription(sourceDescription(client))
      .addFields(
        { name: 'Find the right recording', value: 'Use a song and artist name, select an autocomplete result, or paste a supported public catalog link. Track availability depends on the source, region, and audio server.' },
        { name: 'Spotify links', value: 'Spotify supplies catalog metadata; a playable recording is matched from an enabled audio source. A Spotify match does not guarantee the same audio master or availability.' },
        { name: 'If a stream fails', value: 'Vybatron attempts bounded recovery and preserves your queue. Watch the shared player for its current state; use Skip or try another supported recording if that track remains unavailable.' },
        { name: 'If you cannot hear the bot', value: 'Check the bot’s Speak permission, Discord’s per-user bot volume, your output device, and whether the player is paused or muted. Voice-channel controls require joining the bot’s channel.' },
        { name: 'Effects and live streams', value: 'Effects use standard audio-server filters and affect everyone listening. Use `/filter preset:Original` to reset. Live streams have no reliable end time and cannot be sought.' },
      );
  }
  embed.setFooter({ text: 'Vybatron v2 • Help is visible only to you' });
  const select = new StringSelectMenuBuilder()
    .setCustomId(`help:v2:topic:${ownerId}`)
    .setPlaceholder('Explore Vybatron…')
    .addOptions(HELP_TOPICS.map((entry) => ({ ...entry, default: entry.value === topic.value })));
  const components = [new ActionRowBuilder().addComponents(select)];
  if (inviteUrl) components.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Add to another server').setURL(inviteUrl)));
  return { embeds: [embed], components, allowedMentions: NO_MENTIONS };
}
