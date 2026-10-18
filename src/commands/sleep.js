import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireControl, requireSessionVisibility } from '../utils/guards.js';
import { ephemeralText } from '../utils/messages.js';
import { requestControllerRefresh } from '../utils/player-controller.js';
import { NO_MENTIONS } from '../utils/presentation.js';
import { stopListeningSession } from '../utils/session-stop.js';
import { cancelSleepTimer, setSleepTimer, sleepTimer, sleepTimerText, SLEEP_MINUTES, validSleepMinutes } from '../utils/sleep-timer.js';

export const data = new SlashCommandBuilder()
  .setName('sleep')
  .setDescription('Stop playback after a set time or when the current track ends')
  .addSubcommand(s => s.setName('in').setDescription('Stop playback after a number of minutes')
    .addIntegerOption(o => o.setName('minutes').setDescription(`Minutes until playback stops (${SLEEP_MINUTES.min}–${SLEEP_MINUTES.max})`)
      .setRequired(true).setMinValue(SLEEP_MINUTES.min).setMaxValue(SLEEP_MINUTES.max)))
  .addSubcommand(s => s.setName('after-track').setDescription('Stop playback when the current track ends'))
  .addSubcommand(s => s.setName('cancel').setDescription('Cancel the sleep timer'))
  .addSubcommand(s => s.setName('show').setDescription('Show the sleep timer'));

export const SLEEP_STOP_REASON = 'Sleep timer stopped playback.';

// Ends the session exactly like Stop, then leaves a notification-free notice.
export async function sleepStop(client, player, mode) {
  if (client.lavalink?.getPlayer(player.guildId) !== player || player.getData?.('vybertron.stopping')) return false;
  // The track played to its end; Stop's own cleanup would count it as ended early.
  if (mode === 'track') client.playTracker?.ended(player, 'finished');
  const channelId = player.textChannelId;
  await stopListeningSession(client, player, SLEEP_STOP_REASON);
  const channel = client.channels?.cache?.get(channelId) || await client.channels?.fetch?.(channelId).catch(() => null);
  await channel?.send?.({ content: 'Sleep timer stopped playback and disconnected.', flags: MessageFlags.SuppressNotifications, allowedMentions: NO_MENTIONS })
    .catch(() => console.error('[Sleep] Could not post the sleep timer notice.'));
  return true;
}

export async function execute(interaction) {
  const action = interaction.options.getSubcommand();
  if (action === 'show') {
    const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
    if (!await requireSessionVisibility(interaction, player)) return;
    if (!player) return interaction.reply(ephemeralText('Nothing is playing. Add something with /play.'));
    const text = sleepTimerText(sleepTimer(player));
    return interaction.reply(ephemeralText(text ? `Sleep timer: ${text}` : 'No sleep timer is set.'));
  }

  const player = await requireControl(interaction);
  if (!player) return;
  const client = interaction.client;

  if (action === 'cancel') {
    const cancelled = cancelSleepTimer(player);
    if (cancelled) requestControllerRefresh(client, player);
    return interaction.reply(ephemeralText(cancelled ? 'Sleep timer cancelled.' : 'No sleep timer is set.'));
  }

  const onFire = (target, mode) => sleepStop(client, target, mode);
  if (action === 'after-track') {
    const track = player.queue.current;
    if (!track) return interaction.reply(ephemeralText('Nothing is playing. Use /sleep in to stop after a number of minutes.'));
    if (track.info?.isStream) return interaction.reply(ephemeralText('A live stream has no end. Use /sleep in to stop after a number of minutes.'));
    setSleepTimer(player, { afterTrack: true, onFire });
    requestControllerRefresh(client, player);
    return interaction.reply(ephemeralText('Playback will stop when this track ends.'));
  }

  const minutes = interaction.options.getInteger('minutes');
  if (!validSleepMinutes(minutes)) {
    return interaction.reply(ephemeralText(`Choose ${SLEEP_MINUTES.min} to ${SLEEP_MINUTES.max} minutes.`));
  }
  setSleepTimer(player, { minutes, onFire });
  requestControllerRefresh(client, player);
  return interaction.reply(ephemeralText(`Playback will stop in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`));
}
