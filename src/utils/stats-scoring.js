// Server favorites scoring. Pure: callers pass already visibility-filtered plays.
const DAY = 24 * 60 * 60_000;

export const SCORING = Object.freeze({
  limit: 25,
  // On repeat: a rolling window where each play's weight halves every two weeks.
  onRepeatWindowMs: 90 * DAY,
  halfLifeMs: 14 * DAY,
  // One person replaying a song adds only a quarter play per repeat, so the
  // list reflects what several people chose rather than one person's loop.
  repeatFactor: 0.25,
  // Picks nobody chose (autoplay/radio) or whose requester is unknown (backfill).
  unattendedFactor: 0.5,
  // An early skip subtracts half a play.
  skipPenalty: 0.5,
  // Forgotten gems: popular 60-120 days ago, with no plays since.
  gemsFromMs: 120 * DAY,
  gemsQuietMs: 60 * DAY,
  gemsMinScore: 2,
});

/**
 * @typedef {{ songKey: string, playedAt: number, requesterKind: 'user'|'autoplay'|'cleared'|'unknown',
 *   requesterId: string|null, skipped: boolean }} ScoredPlay
 */

// Distinct requesters count fully. Cleared requests share one anonymous bucket;
// unknown (backfilled) plays have no requester to group by.
function requesterBucket(play, index) {
  if (play.requesterKind === 'user' && play.requesterId) return `user:${play.requesterId}`;
  if (play.requesterKind === 'unknown') return `unknown:${index}`;
  return play.requesterKind;
}

function score(plays, weightOf, now, config) {
  const songs = new Map();
  plays.forEach((play, index) => {
    let song = songs.get(play.songKey);
    if (!song) { song = { songKey: play.songKey, score: 0, plays: 0, lastPlayedAt: 0, buckets: new Map() }; songs.set(play.songKey, song); }
    song.lastPlayedAt = Math.max(song.lastPlayedAt, play.playedAt);
    const weight = weightOf(play, now);
    if (play.skipped) { song.score -= config.skipPenalty * weight; return; }
    song.plays += 1;
    const factor = ['autoplay', 'unknown'].includes(play.requesterKind) ? config.unattendedFactor : 1;
    const bucket = requesterBucket(play, index);
    if (!song.buckets.has(bucket)) song.buckets.set(bucket, []);
    song.buckets.get(bucket).push(weight * factor);
  });
  return [...songs.values()].map(({ buckets, ...song }) => {
    for (const weights of buckets.values()) {
      weights.sort((a, b) => b - a);
      song.score += weights.reduce((sum, weight, index) => sum + weight * (index ? config.repeatFactor : 1), 0);
    }
    return { ...song, score: Math.round(song.score * 1000) / 1000 };
  });
}

const ranked = (songs, limit) => songs.sort((a, b) => b.score - a.score || b.lastPlayedAt - a.lastPlayedAt || (a.songKey < b.songKey ? -1 : 1)).slice(0, limit);

/** "On repeat in this server": recency-decayed, skip-penalized, requester-damped. */
export function onRepeat(plays, now, config = SCORING) {
  const recent = plays.filter(play => play.playedAt <= now && now - play.playedAt <= config.onRepeatWindowMs);
  const decay = (play, at) => 0.5 ** ((at - play.playedAt) / config.halfLifeMs);
  return ranked(score(recent, decay, now, config).filter(song => song.score > 0), config.limit);
}

/** "Forgotten gems": popular 60-120 days ago and not played in the last 60 days. */
export function forgottenGems(plays, now, config = SCORING) {
  const quietSince = now - config.gemsQuietMs;
  const recentlyPlayed = new Set(plays.filter(play => play.playedAt > quietSince && play.playedAt <= now).map(play => play.songKey));
  const earlier = plays.filter(play => play.playedAt <= quietSince && now - play.playedAt <= config.gemsFromMs && !recentlyPlayed.has(play.songKey));
  return ranked(score(earlier, () => 1, now, config).filter(song => song.score >= config.gemsMinScore), config.limit);
}

/** Early skip: ended by moving on before 30 seconds or 40% of the track. */
export function isEarlySkip({ playedMs, durationMs }) {
  return playedMs < 30_000 || (durationMs > 0 && playedMs < durationMs * 0.4);
}

/** Completion: reached the natural end, or at least 90% of the track. */
export function isComplete({ playedMs, durationMs, finished }) {
  return Boolean(finished) || (durationMs > 0 && playedMs >= durationMs * 0.9);
}
