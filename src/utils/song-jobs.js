import { logEvent } from '../runtime.js';
import { FINGERPRINT, fingerprintOf, similarity } from './fingerprint.js';
import { recordingKey, recordingQuery, sameLength } from './song-identity.js';

const HOUR = 60 * 60_000;
// Uploads compared per alternates check; each costs a background download and a measurement.
const CANDIDATES = 3;
// Device plays waiting for their metadata, how long a device play is remembered,
// and how often a lookup that failed is tried again.
const DEVICE_PENDING = 50;
const DEVICE_REPEAT_MS = 10 * 60_000;
const DEVICE_ATTEMPTS = 3;
const watchUrl = id => `https://www.youtube.com/watch?v=${id}`;

class Temporary extends Error {}

/**
 * Measures one YouTube upload's fingerprint through the portal's analysis cache,
 * which downloads only in the audio cache's background slot (ADR-0013).
 * @returns {Promise<Buffer|null>} null when the song can't be measured
 */
export function measureWith(analyses, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 30 } = {}) {
  return async id => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      let body;
      try { body = await analyses.get(id); }
      catch (error) {
        if (error?.status === 404) return null;
        throw new Temporary(error?.code || 'analysis_failed');
      }
      if (body?.status === 'ready') return fingerprintOf(Buffer.from(body.levels, 'base64'), body.frameCount);
      await wait(Math.max(500, Number(body?.retryMs) || 2000));
    }
    throw new Temporary('analysis_pending');
  };
}

// Uploads that might be the song: the same recording by artist and title, the
// same length, and not already one of its sources. Only an audio match decides.
// The largest group of measured uploads that all match each other, at least two (ADR-0017).
export function agreeingGroup(measured) {
  let best = [];
  for (const anchor of measured) {
    const group = [anchor];
    for (const other of measured) {
      if (other !== anchor && group.every(member => similarity(member.fingerprint, other.fingerprint) >= FINGERPRINT.threshold)) group.push(other);
    }
    if (group.length > best.length) best = group;
  }
  return best.length >= 2 ? best : [];
}

export function alternateCandidates(song, results) {
  const key = recordingKey(song);
  const seen = new Set(song.sources);
  const candidates = [];
  for (const track of results) {
    const info = track?.info || {};
    if (info.sourceName !== 'youtube' || info.isStream || !/^[\w-]{11}$/.test(info.identifier || '') || seen.has(info.uri)) continue;
    if (!key || recordingKey(info) !== key || !sameLength(song.duration, info.duration)) continue;
    seen.add(info.uri); candidates.push(track);
    if (candidates.length >= CANDIDATES) break;
  }
  return candidates;
}

/**
 * ADR-0017 step 2, one action a tick: record a device play, fingerprint a
 * song, or look for its alternates. Every failure is contained; none reaches
 * playback.
 */
export function startSongJobs(client, { measure, search, intervalMs = 60_000, now = Date.now, logger = console } = {}) {
  const store = client.songs;
  // Video ID -> { attempts, notBefore } for device plays still to be looked up.
  const pending = new Map(); const seen = new Map();
  let running = false; let timer = null; let lastFailureLog = 0; let turn = 0;
  const failed = (event, error) => {
    if (now() - lastFailureLog < 60_000) return;
    lastFailureLog = now(); logEvent(logger, 'error', event, error);
  };
  const results = async (query, source) => {
    const found = await search(query, source);
    if (!found || found.loadType === 'error') throw new Temporary('search_failed');
    return Array.isArray(found.tracks) ? found.tracks : [];
  };

  // A device play reaches the bot as a video ID. A known song is marked used;
  // an unknown one is looked up by its URL and recorded like a Discord play.
  const recordDevice = async id => {
    const tracks = await results(watchUrl(id));
    const track = tracks.find(item => item?.info?.identifier === id);
    if (track) store.record(track);
  };

  // A failure, temporary or not, is recorded, so the song waits its turn again
  // instead of being measured on every tick.
  const fingerprint = async ({ id, identifier }) => {
    let measured = null;
    try { measured = await measure(identifier); }
    finally { store.setFingerprint(id, measured); }
  };

  // `checking.id` follows the song through a merge: the older song survives.
  const alternates = async (song, checking) => {
    const found = [];
    if (song.isrc) found.push(...await results(`"${song.isrc}"`, 'ytsearch'));
    found.push(...await results(recordingQuery(song), 'ytmsearch'));
    for (const candidate of alternateCandidates(song, found)) {
      const measured = await measure(candidate.info.identifier);
      if (!measured) continue;
      const score = similarity(song.fingerprint, measured);
      if (score >= FINGERPRINT.threshold) checking.id = store.addVerifiedSource(checking.id, candidate, Math.round(score * 1000) / 1000) || checking.id;
    }
    store.alternatesChecked(checking.id);
  };

  // A song whose own upload couldn't be measured: other uploads stand in only when at
  // least two of them agree on the audio. The first then fingerprints the song.
  const agreement = async (song, checking) => {
    const found = [];
    if (song.isrc) found.push(...await results(`"${song.isrc}"`, 'ytsearch'));
    found.push(...await results(recordingQuery(song), 'ytmsearch'));
    const measured = [];
    for (const candidate of alternateCandidates(song, found)) {
      const fingerprint = await measure(candidate.info.identifier);
      if (fingerprint) measured.push({ candidate, fingerprint });
    }
    const group = agreeingGroup(measured);
    if (group.length) {
      let weakest = 1;
      for (const a of group) for (const b of group) if (a !== b) weakest = Math.min(weakest, similarity(a.fingerprint, b.fingerprint));
      for (const { candidate } of group) checking.id = store.addVerifiedSource(checking.id, candidate, Math.round(weakest * 1000) / 1000, undefined, 'agreement') || checking.id;
      store.setFingerprint(checking.id, group[0].fingerprint);
    }
    store.alternatesChecked(checking.id);
  };

  const tick = async () => {
    if (running || !store?.available) return;
    running = true;
    let checking = null;
    try {
      const device = [...pending].find(([, entry]) => entry.notBefore <= now());
      if (device) {
        const [id, entry] = device; pending.delete(id);
        try { await recordDevice(id); }
        catch (error) {
          if (entry.attempts + 1 < DEVICE_ATTEMPTS) pending.set(id, { attempts: entry.attempts + 1, notBefore: now() + DEVICE_REPEAT_MS });
          throw error;
        }
        return;
      }
      const steps = [() => { const due = store.fingerprintDue(); return due && fingerprint(due); },
        () => { const song = store.alternatesDue(); if (!song) return null; checking = { id: song.id }; return alternates(song, checking); },
        () => { const song = store.agreementDue(); if (!song) return null; checking = { id: song.id }; return agreement(song, checking); }];
      // Each kind of work takes its turn first, so none waits on the others.
      const first = turn++ % steps.length;
      steps.push(...steps.splice(0, first));
      for (const step of steps) { const work = step(); if (work) { await work; return; } }
    } catch (error) {
      if (checking) store.alternatesChecked(checking.id, { retryAfterMs: 6 * HOUR });
      if (!(error instanceof Temporary)) failed('songs_job_failed', error);
    } finally { running = false; }
  };

  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return {
    tick,
    /** A device asked for a song's audio. Never throws. */
    devicePlayed(id) {
      try {
        if (!store?.available || !/^[\w-]{11}$/.test(id) || (seen.get(id) ?? -Infinity) > now() - DEVICE_REPEAT_MS) return;
        seen.set(id, now());
        if (seen.size > 500) for (const [key, at] of seen) if (at <= now() - DEVICE_REPEAT_MS) seen.delete(key);
        if (!store.touch(watchUrl(id)) && !pending.has(id) && pending.size < DEVICE_PENDING) pending.set(id, { attempts: 0, notBefore: now() });
      } catch (error) { failed('songs_job_failed', error); }
    },
    stop() { clearInterval(timer); timer = null; pending.clear(); },
  };
}
