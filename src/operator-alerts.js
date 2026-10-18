import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getHealth } from './health.js';
import { logEvent } from './runtime.js';
import { playbackHealth } from './utils/playback-health.js';
import { NO_MENTIONS } from './utils/presentation.js';

export const ALERT_MUTE_ID = 'alerts:v1:mute';
export const ALERT_UNMUTE_ID = 'alerts:v1:unmute';

const MINUTE = 60_000;
const COUNTER_WINDOW_MS = 10 * MINUTE;

// Each condition reads aggregate counts only. Alert text is fixed copy plus
// numbers, so it can never carry guild/user IDs, titles, URLs, or provider errors.
// raiseAfter/resolveAfter count consecutive checks, which debounces flapping.
export const ALERT_CONDITIONS = [
  {
    key: 'audio-offline',
    raiseAfter: 4,
    resolveAfter: 2,
    active: (signals) => signals.discordReady && !signals.audioReady,
    message: () => 'The audio service is offline. Songs can’t start or continue until it reconnects.',
    resolved: 'Resolved: the audio service is back online.',
  },
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
  return {
    discordReady: health.discordReady,
    audioReady: health.audioReady,
    draining: health.draining,
    recentFailures: playbackHealth(client).failures.length,
    circuitTrips: Number(recovery.circuitTrips) || 0,
    statsUnavailable: stats ? stats.available === false : false,
    statsFailures: stats ? (Number(stats.writeFailures) || 0) + (Number(stats.droppedWrites) || 0) : 0,
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

// Per-recipient mute list. A missing or unreadable file means nobody is muted.
export function createAlertPreferences(filePath, { io = fs, logger = console } = {}) {
  let muted = new Set();
  let pending = Promise.resolve();
  return {
    async load() {
      try {
        const document = JSON.parse(await io.readFile(filePath, 'utf8'));
        muted = new Set((Array.isArray(document?.muted) ? document.muted : []).filter((id) => /^\d{1,22}$/.test(id)));
      } catch (error) {
        if (error?.code !== 'ENOENT') logEvent(logger, 'error', 'operator_alert_preferences_unreadable', error);
      }
      return this;
    },
    muted: (userId) => muted.has(String(userId)),
    setMuted(userId, value) {
      pending = pending.catch(() => {}).then(async () => {
        // Build from the latest committed list so concurrent changes can't undo each other.
        const next = new Set(muted);
        if (value) next.add(String(userId)); else next.delete(String(userId));
        await io.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        const temporary = `${filePath}.${randomUUID()}.tmp`;
        try {
          await io.writeFile(temporary, JSON.stringify({ version: 1, muted: [...next] }), { mode: 0o600 });
          await io.rename(temporary, filePath);
        } finally { await io.unlink(temporary).catch(() => {}); }
        muted = next;
      });
      return pending;
    },
  };
}

// The application owner (or verified team owner) plus PORTAL_OPERATOR_IDS,
// matching who may see the install link.
export async function alertRecipients(client) {
  const ids = new Set(client?.operatorIds || []);
  const application = client?.application;
  let owner = application?.owner;
  if (!owner && typeof application?.fetch === 'function') owner = (await application.fetch().catch(() => null))?.owner;
  const ownerId = owner?.ownerId || owner?.id;
  if (ownerId) ids.add(String(ownerId));
  return [...ids].filter((id) => /^\d{1,22}$/.test(id));
}

function muteRow(muted) {
  return new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(muted ? ALERT_UNMUTE_ID : ALERT_MUTE_ID)
    .setStyle(ButtonStyle.Secondary)
    .setLabel(muted ? 'Turn audio alerts back on' : 'Mute audio alerts'));
}

export function isAlertInteraction(interaction) {
  return interaction.isButton?.() && [ALERT_MUTE_ID, ALERT_UNMUTE_ID].includes(interaction.customId);
}

export async function handleAlertInteraction(interaction, { recipients = alertRecipients } = {}) {
  const alerts = interaction.client.operatorAlerts;
  const userId = String(interaction.user?.id || '');
  if (!alerts || !(await recipients(interaction.client)).includes(userId)) {
    return interaction.reply({ content: 'Audio alerts are only for the bot owner and operators.', flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
  }
  const mute = interaction.customId === ALERT_MUTE_ID;
  await alerts.preferences.setMuted(userId, mute);
  return interaction.reply({
    content: mute
      ? 'Audio alerts are muted. You won’t get messages when playback degrades.'
      : 'Audio alerts are on. You’ll get a message when playback degrades and when it recovers.',
    components: [muteRow(mute)],
    allowedMentions: NO_MENTIONS,
  });
}

/**
 * Polls aggregate health on its own timer, so alerting can never block or
 * fail playback. Delivery is a DM through the existing bot client.
 */
export async function startOperatorAlerts(client, {
  dataDir,
  intervalMs = 30_000,
  logger = console,
  monitor = createAlertMonitor(),
  preferences = createAlertPreferences(path.join(dataDir, 'operator-alerts.json'), { logger }),
  recipients = alertRecipients,
  timers = { setInterval, clearInterval },
} = {}) {
  await preferences.load();
  let delivering = Promise.resolve();

  async function deliver(messages) {
    let ids = [];
    try { ids = await recipients(client); } catch {}
    for (const message of messages) {
      for (const id of ids) {
        if (preferences.muted(id)) continue;
        try {
          const user = await client.users.fetch(id);
          await user.send({ content: message.text, components: [muteRow(false)], allowedMentions: NO_MENTIONS });
        } catch (error) {
          logEvent(logger, 'warn', 'operator_alert_failed', error);
        }
      }
      logger.log(JSON.stringify({ event: 'operator_alert', condition: message.key, kind: message.kind }));
    }
  }

  function tick() {
    try {
      const messages = monitor.check(readSignals(client));
      if (messages.length) delivering = delivering.then(() => deliver(messages)).catch(() => {});
    } catch (error) {
      logEvent(logger, 'error', 'operator_alert_check_failed', error);
    }
  }

  const interval = timers.setInterval(tick, intervalMs);
  interval?.unref?.();
  const alerts = { preferences, monitor, tick, stop: () => timers.clearInterval(interval), idle: () => delivering };
  client.operatorAlerts = alerts;
  return alerts;
}
