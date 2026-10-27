import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logEvent } from '../runtime.js';
import { withTimeout } from './enqueue.js';
import { trackReference } from './library.js';
import { songKey } from './song-identity.js';

// One-time upgrade of saved YouTube videos (favorites and mixes) to their YouTube
// Music song uploads, after search switched to YouTube Music. 'dry-run' only writes
// the report; 'apply' backs up library.json and rewrites the matches.
export const UPGRADE_MODE = 'dry-run';
export const UPGRADE_REPORT = 'saved-song-upgrade.json';
const CANDIDATES = 5;

function* savedReferences(library) {
  for (const userId of library.favoriteUserIds()) yield* library.favorites(userId).map(ref => ['favorites', ref]);
  for (const guildId of library.guildIds()) {
    for (const mix of Object.values(library.readGuild(guildId).mixes || {})) yield* mix.tracks.map(ref => ['mix', ref]);
  }
}

// The song upload whose identity matches, `null` when the saved link is already
// that song, or `undefined` when nothing matches. Live, remix and cover versions
// keep distinct identities, so they never match the studio song.
export async function findSong(node, ref, { timeoutMs = 10_000 } = {}) {
  const key = songKey(ref);
  const result = await withTimeout(node.search({ query: `${ref.author} ${ref.title}`, source: 'ytmsearch' }, null), timeoutMs);
  for (const track of (result?.tracks || []).slice(0, CANDIDATES)) {
    const candidate = trackReference(track);
    if (candidate?.sourceName !== 'youtube' || candidate.isStream || songKey(candidate) !== key) continue;
    return candidate.uri === ref.uri ? null : candidate;
  }
  return undefined;
}

// Replaces upgraded links in place. An entry whose song is already in the list is
// dropped instead, so a list never holds the same song twice.
export function upgradeList(list, upgrades) {
  let changed = 0;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const next = upgrades.get(list[index].uri);
    if (!next) continue;
    if (list.some(ref => ref.uri === next.uri)) list.splice(index, 1);
    else list[index] = next;
    changed += 1;
  }
  return changed;
}

async function applyUpgrades(library, upgrades) {
  const affected = list => list.some(ref => upgrades.has(ref.uri));
  await library.publishBackup(`${library.filePath}.pre-song-upgrade.bak`, await fs.readFile(library.filePath, 'utf8'));
  let favorites = 0, mixes = 0;
  for (const userId of library.favoriteUserIds()) {
    if (affected(library.favorites(userId))) favorites += await library.updateFavorites(userId, list => upgradeList(list, upgrades));
  }
  for (const guildId of library.guildIds()) {
    if (!Object.values(library.readGuild(guildId).mixes || {}).some(mix => affected(mix.tracks))) continue;
    mixes += await library.updateGuild(guildId, guild => Object.values(guild.mixes).reduce((sum, mix) => sum + upgradeList(mix.tracks, upgrades), 0));
  }
  return { favorites, mixes };
}

/**
 * Runs the upgrade once per mode. The report in the data directory marks it done;
 * an interrupted run writes none and starts over on the next start.
 * @returns {Promise<object|null>} the report, or null when skipped or interrupted
 */
export async function upgradeSavedSongs({ library, node, mode = UPGRADE_MODE, draining = () => false,
  pauseMs = 1_000, logger = console, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const reportPath = path.join(path.dirname(library.filePath), UPGRADE_REPORT);
  try { if (JSON.parse(await fs.readFile(reportPath, 'utf8')).mode === mode) return null; } catch {}
  const saved = new Map(); const lists = new Map();
  for (const [list, ref] of savedReferences(library)) {
    if (ref.sourceName !== 'youtube' || ref.isStream) continue;
    saved.set(ref.uri, ref);
    lists.set(ref.uri, new Set([...(lists.get(ref.uri) || []), list]));
  }
  const upgrades = new Map(); const counts = { checked: 0, current: 0, unmatched: 0, failed: 0 };
  for (const ref of saved.values()) {
    if (draining()) return null;
    counts.checked += 1;
    try {
      const song = await findSong(node, ref);
      if (song) upgrades.set(ref.uri, song);
      else counts[song === null ? 'current' : 'unmatched'] += 1;
    } catch { counts.failed += 1; }
    await wait(pauseMs);
  }
  if (draining()) return null;
  const applied = mode === 'apply' ? await applyUpgrades(library, upgrades) : null;
  const report = { version: 1, mode, finishedAt: new Date(now()).toISOString(), ...counts, upgrades: upgrades.size, applied,
    changes: [...upgrades].map(([uri, song]) => ({ lists: [...lists.get(uri)],
      from: { title: saved.get(uri).title, author: saved.get(uri).author, uri }, to: { title: song.title, author: song.author, uri: song.uri } })) };
  const temporary = `${reportPath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600 });
  await fs.rename(temporary, reportPath);
  // Counts only: titles and links stay in the private report.
  logger.info(JSON.stringify({ event: 'saved_song_upgrade', mode, ...counts, upgrades: upgrades.size, ...(applied ? { applied } : {}) }));
  return report;
}

// Starts a few minutes after the audio service connects, away from deploy traffic.
export function scheduleSavedSongUpgrade(client, { delayMs = 5 * 60_000, retryMs = 60_000 } = {}) {
  const attempt = async () => {
    if (client.runtimeState?.draining) return;
    const node = client.lavalink?.nodeManager?.leastUsedNodes?.()[0];
    if (!node?.connected) { schedule(retryMs); return; }
    await upgradeSavedSongs({ library: client.library, node, draining: () => Boolean(client.runtimeState?.draining) });
  };
  const schedule = ms => setTimeout(() => attempt().catch(error => logEvent(console, 'error', 'saved_song_upgrade_failed', error)), ms).unref?.();
  schedule(delayMs);
}
