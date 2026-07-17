export async function togglePlayback(player) {
  const wasPaused = player.paused;
  if (wasPaused) await player.resume();
  else await player.pause();
  return wasPaused ? 'resumed' : 'paused';
}

export async function skipCurrent(player) {
  const track = player.queue.current;
  if (!track) return null;
  if (player.queue.tracks.length > 0) await player.skip();
  else await player.stopPlaying(true, false);
  return track;
}

export async function shuffleQueue(player) {
  if (player.queue.tracks.length < 2) return 0;
  await player.queue.shuffle();
  return player.queue.tracks.length;
}

export async function setLoopMode(player, mode) {
  if (!['off', 'track', 'queue'].includes(mode)) return null;
  await player.setRepeatMode(mode);
  return mode;
}

export function nextLoopMode(current) {
  const modes = ['off', 'track', 'queue'];
  const index = modes.indexOf(current);
  return modes[(index + 1) % modes.length];
}

export async function removeQueuedTrack(player, position) {
  if (!Number.isInteger(position) || position < 1 || position > player.queue.tracks.length) return null;
  return player.queue.splice(position - 1, 1);
}

export async function moveQueuedTrack(player, from, to) {
  const length = player.queue.tracks.length;
  if (!Number.isInteger(from) || !Number.isInteger(to)
    || from < 1 || from > length || to < 1 || to > length || from === to) return null;
  const track = await player.queue.splice(from - 1, 1);
  await player.queue.splice(to - 1, 0, track);
  return track;
}
