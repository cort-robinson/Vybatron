import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { AUTOPLAY_LIMITS, dismissSuggestion, fillRadioQueue, isAutoplayTrack, lessLikeThis, promoteSuggestion, pruneSuggestions, refreshSuggestions, setRadio, takeSuggestion } from '../utils/radio.js';
import { autocompleteTracks } from '../utils/autocomplete.js';
import { ephemeralText } from '../utils/messages.js';
import { skipCurrent } from '../utils/operations.js';
import { safeText } from '../utils/presentation.js';
import { requestControllerRefresh } from '../utils/player-controller.js';
import { directControlPresentation } from '../utils/presentation-updates.js';
import { resolveTrackQuery, searchFailureMessage, validatePlaybackQuery } from '../utils/search.js';

const position = (option, required = true) => option.setName('position').setDescription('Suggestion number, as shown in the queue').setMinValue(1).setMaxValue(AUTOPLAY_LIMITS.suggestions).setRequired(required);

export const data = new SlashCommandBuilder().setName('radio').setDescription('Keep the music going with songs related to what you are playing')
  .addSubcommand(s => s.setName('on').setDescription('Start autoplay for this session, optionally from a chosen song')
    .addStringOption(o => o.setName('track').setDescription('Song or link to start from; defaults to the current song').setMaxLength(200).setAutocomplete(true)))
  .addSubcommand(s => s.setName('off').setDescription('Stop autoplay for this session; keep all queued songs'))
  .addSubcommand(s => s.setName('promote').setDescription('Move a suggested song into the queue').addIntegerOption(o => position(o)))
  .addSubcommand(s => s.setName('remove').setDescription('Remove a suggested song').addIntegerOption(o => position(o)))
  .addSubcommand(s => s.setName('less').setDescription('Hear less like a suggestion; omit the number to skip the current autoplay song').addIntegerOption(o => position(o, false)))
  .addSubcommand(s => s.setName('mytaste').setDescription('Choose whether autoplay uses your taste while you are in voice with the bot')
    .addBooleanOption(o => o.setName('enabled').setDescription('On by default. Off keeps your requests and favorites out of autoplay').setRequired(true)));

export const autocomplete = autocompleteTracks;

function sessionChanged(interaction, player) { return interaction.client.lavalink.getPlayer(interaction.guildId) !== player; }

async function turnOn(interaction, player) {
  const query = interaction.options.getString('track');
  let seed = player.queue.current || player.queue.previous?.[0];
  if (query) {
    const invalid = validatePlaybackQuery(query);
    if (invalid) return interaction.reply(ephemeralText(invalid));
    const { result, expired } = await resolveTrackQuery(player, query, interaction.user);
    if (expired) return interaction.reply(ephemeralText('That search suggestion expired. Type your search again and choose a fresh result.'));
    if (!result?.tracks?.length) return interaction.reply(ephemeralText(searchFailureMessage(result, query)));
    await interaction.portalRecheck?.();
    // requireControl marked this command as writing before the seed lookup.
    interaction.portalAssertLive?.();
    if (sessionChanged(interaction, player)) return interaction.reply(ephemeralText('The listening session changed while loading. Try again.'));
    seed = result.tracks[0];
  }
  if (!seed) return interaction.reply(ephemeralText('Play a song first, or choose one to start from, so autoplay has a starting point.'));
  setRadio(player, true, seed);
  await directControlPresentation(interaction, player);
  // An idle session starts from the first pick; otherwise picks wait behind the queue.
  if (!player.queue.current && !player.queue.tracks.length) {
    if (await fillRadioQueue(player, null, interaction.client) && !player.playing && !player.paused) await player.play();
  } else void refreshSuggestions(player, interaction.client).catch(() => {});
  const title = safeText(seed.info?.title, { maxLength: 120 });
  return interaction.reply(ephemeralText(`Autoplay is on, starting from **${title}**. Related songs play after the queue ends; songs people queue always play first. Use /radio off to stop.`));
}

// A personal preference for every server: no voice channel or DJ access needed (ADR-0012).
async function setTaste(interaction) {
  const enabled = interaction.options.getBoolean('enabled');
  await interaction.client.library.setTasteInAutoplay(interaction.user.id, enabled);
  // Picks already prepared for this listener are dropped before the next one plays.
  const player = interaction.client.lavalink?.getPlayer?.(interaction.guildId);
  if (player) { pruneSuggestions(player, interaction.client); void refreshSuggestions(player, interaction.client).catch(() => {}); }
  return interaction.reply(ephemeralText(enabled
    ? 'Autoplay will take turns with your taste while you’re in voice with Vybatron. It uses songs you’ve requested and your favorites, in every server.'
    : 'Autoplay won’t use your taste anymore, in any server. Your requests and favorites are unchanged. Use /radio mytaste enabled:True to turn it back on.'));
}

export async function execute(interaction) {
  const action = interaction.options.getSubcommand();
  if (action === 'mytaste') return setTaste(interaction);
  // Promoting a suggestion is an ordinary addition; listeners in voice may do it.
  const player = await requireControl(interaction, { checkDJ: action !== 'promote' }); if (!player) return;
  const index = (interaction.options.getInteger?.('position') || 0) - 1;
  const expected = track => { interaction.portalAssertSuggestion?.(track); return true; };
  if (action === 'on') return turnOn(interaction, player);
  if (action === 'off') {
    setRadio(player, false);
    // Urgent cancellation bypasses the ordinary lane. It must not retain a
    // per-command waiter behind a stalled cosmetic writer.
    requestControllerRefresh(interaction.client, player);
    return interaction.reply(ephemeralText('Autoplay is off for this session. Songs already queued will keep playing.'));
  }
  if (action === 'promote') {
    const entry = takeSuggestion(player, index, expected);
    if (!entry) return interaction.reply(ephemeralText('That suggestion changed. Check the queue and try again.'));
    if (!await promoteSuggestion(player, interaction.client, entry)) {
      requestControllerRefresh(interaction.client, player);
      return interaction.reply(ephemeralText('That suggestion was picked for someone who left or turned off their taste, so it was removed. Check the queue and try again.'));
    }
    if (!player.playing && !player.paused && !player.queue.current) await player.play();
    void refreshSuggestions(player, interaction.client).catch(() => {});
    requestControllerRefresh(interaction.client, player);
    return interaction.reply(ephemeralText(`Added **${safeText(entry.track.info?.title, { maxLength: 140 })}** to the queue.`));
  }
  if (action === 'less' && index < 0) {
    const current = player.queue.current;
    if (!isAutoplayTrack(player, current)) return interaction.reply(ephemeralText('Less like this applies to songs autoplay picked. Use /skip for other songs.'));
    interaction.portalAssertSuggestion?.(current);
    lessLikeThis(player, current);
    await skipCurrent(player, interaction.client);
    return interaction.reply(ephemeralText(`Skipped **${safeText(current.info?.title, { maxLength: 140 })}**. Autoplay will play less like it.`));
  }
  const removed = dismissSuggestion(player, index, { dislike: action === 'less', expected });
  if (!removed) return interaction.reply(ephemeralText('That suggestion changed. Check the queue and try again.'));
  void refreshSuggestions(player, interaction.client).catch(() => {});
  requestControllerRefresh(interaction.client, player);
  return interaction.reply(ephemeralText(action === 'less'
    ? `Removed **${safeText(removed.info?.title, { maxLength: 140 })}**. Autoplay will play less like it.`
    : `Removed **${safeText(removed.info?.title, { maxLength: 140 })}** from suggestions.`));
}
