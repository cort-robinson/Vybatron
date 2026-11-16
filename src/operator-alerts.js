import { randomUUID } from 'node:crypto';
import { MessageFlags } from 'discord.js';
import { getHealth } from './health.js';
import { logEvent } from './runtime.js';
import { LIBRARY_WARNING_RATIO } from './utils/library.js';
import { playbackHealth } from './utils/playback-health.js';
import { NO_MENTIONS } from './utils/presentation.js';

export const ALERT_MUTE_ID = 'alerts:v1:mute';
export const ALERT_UNMUTE_ID = 'alerts:v1:unmute';

const MINUTE = 60_000;
const COUNTER_WINDOW_MS = 10 * MINUTE;

// Each condition reads aggregate counts only. Alert text is fixed copy plus
// numbers, so it can never carry guild/user IDs, titles, URLs, or provider errors.
// raiseAfter/resolveAfter count consecutive checks, which debounces flapping.
// An offline audio service is not here: the host recovery monitor reports it
// (and repairs it), so the alerts channel never gets the same outage twice.
export const ALERT_CONDITIONS = [
  {
    key: 'playback-failures',
    raiseAfter: 2,
    resolveAfter: 4,
    active: (signals, state) => signals.recentFailures >= (state.raised ? 2 : 5),
    message: (signals) => `${signals.recentFailures} songs failed to play in the last 15 minutes.`,
    resolved: 'Resolved: songs are playing normally again.',
  },
  {
    key: 'source-breaker',
    raiseAfter: 1,
    resolveAfter: 2,
    active: (signals) => signals.recentCircuitTrips > 0,
    message: (signals) => `An audio source failed repeatedly and was paused ${signals.recentCircuitTrips} ${signals.recentCircuitTrips === 1 ? 'time' : 'times'} in the last 10 minutes.`,
    resolved: 'Resolved: no audio source has been paused in the last 10 minutes.',
  },
  {
    key: 'stats-store',
    raiseAfter: 1,
    resolveAfter: 2,
    active: (signals) => signals.statsUnavailable || signals.recentStatsFailures > 0,
    message: (signals) => signals.statsUnavailable
      ? 'Play statistics are unavailable. Playback is unaffected; check the data volume.'
      : `${signals.recentStatsFailures} play statistics writes failed in the last 10 minutes. Playback is unaffected; check the data volume.`,
    resolved: 'Resolved: play statistics are saving again.',
  },
  {
    key: 'library-capacity',
    raiseAfter: 1,
    resolveAfter: 2,
    // A little hysteresis keeps a library hovering at the threshold from flapping.
    active: (signals, state) => signals.libraryPercent >= LIBRARY_WARNING_RATIO * 100 - (state.raised ? 5 : 0),
    message: (signals) => `The music library is ${signals.libraryPercent}% full. Saves fail for every server once it is full.`,
    resolved: 'Resolved: the music library has room again.',
  },
];

// A final guard in case a future condition interpolates something it shouldn't.
export function safeAlertText(text) {
  return String(text)
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/\d{15,}/g, '[id]')
    .slice(0, 300);
}

// Cumulative process counters become "how many in the recent window".
export function readSignals(client) {
  const health = getHealth(client);
  const recovery = client.lavalink?.playbackRecovery?.summary?.() || {};
  const stats = client.stats?.status?.() || null;
  const library = client.library?.capacity?.() || null;
  return {
    discordReady: health.discordReady,
    audioReady: health.audioReady,
    draining: health.draining,
    recentFailures: playbackHealth(client).failures.length,
    circuitTrips: Number(recovery.circuitTrips) || 0,
    statsUnavailable: stats ? stats.available === false : false,
    statsFailures: stats ? (Number(stats.writeFailures) || 0) + (Number(stats.droppedWrites) || 0) : 0,
    libraryPercent: library?.limitBytes > 0 ? Math.floor(library.bytes / library.limitBytes * 100) : 0,
  };
}

/**
 * Debounced, rate-limited alert state. check() takes a signal sample and
 * returns the messages to deliver; it never throws and never sends itself.
 */
export function createAlertMonitor({
  conditions = ALERT_CONDITIONS,
  now = Date.now,
  cooldownMs = 30 * MINUTE,
  hourlyLimit = 6,
} = {}) {
  const states = new Map(conditions.map((condition) => [condition.key, { raised: false, notified: false,
    activeChecks: 0, quietChecks: 0, lastAlertAt: -Infinity }]));
  const samples = [];
  const sent = [];

  function recent(signals, name) {
    const latest = signals[name] || 0;
    const oldest = samples.find((sample) => now() - sample.at <= COUNTER_WINDOW_MS);
    return Math.max(0, latest - (oldest ? oldest[name] : latest));
  }

  function allow() {
    while (sent.length && now() - sent[0] >= 60 * MINUTE) sent.shift();
    if (sent.length >= hourlyLimit) return false;
    sent.push(now());
    return true;
  }

  function check(raw) {
    const signals = { ...raw,
      recentCircuitTrips: recent(raw, 'circuitTrips'),
      recentStatsFailures: recent(raw, 'statsFailures') };
    samples.push({ at: now(), circuitTrips: raw.circuitTrips || 0, statsFailures: raw.statsFailures || 0 });
    while (samples.length && now() - samples[0].at > COUNTER_WINDOW_MS) samples.shift();
    // Shutdown and deploys take the audio service down on purpose, and nothing
    // can be delivered before Discord is connected.
    if (raw.draining || !raw.discordReady) return [];
    const messages = [];
    for (const condition of conditions) {
      const state = states.get(condition.key);
      let active = false;
      try { active = Boolean(condition.active(signals, state)); } catch {}
      state.activeChecks = active ? state.activeChecks + 1 : 0;
      state.quietChecks = active ? 0 : state.quietChecks + 1;
      if (!state.raised && state.activeChecks >= condition.raiseAfter) state.raised = true;
      if (state.raised && active && !state.notified) {
        // A condition that flaps inside its cooldown stays quiet, and so does its
        // resolve. One that persists is reported as soon as the limits allow.
        if (now() - state.lastAlertAt >= cooldownMs && allow()) {
          state.notified = true;
          state.lastAlertAt = now();
          messages.push({ key: condition.key, kind: 'alert', text: safeAlertText(`Audio alert: ${condition.message(signals)}`) });
        }
      } else if (state.raised && state.quietChecks >= condition.resolveAfter) {
        state.raised = false;
        // Resolves pair one-to-one with sent alerts, so they bypass the hourly cap.
        if (state.notified) messages.push({ key: condition.key, kind: 'resolved', text: safeAlertText(condition.resolved) });
        state.notified = false;
      }
    }
    return messages;
  }

  return { check, active: () => [...states].filter(([, state]) => state.raised).map(([key]) => key) };
}

export function isAlertInteraction(interaction) {
  return interaction.isButton?.() && [ALERT_MUTE_ID, ALERT_UNMUTE_ID].includes(interaction.customId);
}

// Alerts used to arrive as DMs with a mute button; an old button now says where they went.
export async function handleAlertInteraction(interaction) {
  return interaction.reply({
    content: 'Audio alerts now post in the alerts channel with the other monitoring alerts, so there is nothing to mute here.',
    flags: MessageFlags.Ephemeral,
    allowedMentions: NO_MENTIONS,
  });
}

const MAX_QUEUED = 32;

/**
 * Polls aggregate health on its own timer, so alerting can never block or
 * fail playback. Alerts wait in a small queue on the loopback /alerts route;
 * the host recovery monitor posts new ones to the alerts channel with its own,
 * so every alert reaches one place, even when the bot itself is down.
 */
export async function startOperatorAlerts(client, {
  intervalMs = 30_000,
  logger = console,
  monitor = createAlertMonitor(),
  timers = { setInterval, clearInterval },
} = {}) {
  const queue = [];

  function tick() {
    try {
      for (const message of monitor.check(readSignals(client))) {
        queue.push({ id: randomUUID(), at: Date.now(), text: message.text });
        logger.log(JSON.stringify({ event: 'operator_alert', condition: message.key, kind: message.kind }));
      }
      queue.splice(0, Math.max(0, queue.length - MAX_QUEUED));
    } catch (error) {
      logEvent(logger, 'error', 'operator_alert_check_failed', error);
    }
  }

  const interval = timers.setInterval(tick, intervalMs);
  interval?.unref?.();
  const alerts = { monitor, tick, stop: () => timers.clearInterval(interval), pending: () => queue.map((item) => ({ ...item })) };
  client.operatorAlerts = alerts;
  return alerts;
}
