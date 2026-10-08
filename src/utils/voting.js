import { trackIdentity } from './presentation.js';
import { skipCurrent } from './operations.js';

const votes = new WeakMap();
export function recordSkipVote(player, userId, humanIds) {
  const track = player.queue.current;
  if (!track) return { error: 'Nothing is playing.' };
  const humans = new Set(humanIds);
  if (!humans.has(userId)) return { error: 'Join the bot’s voice channel to vote.' };
  let state = votes.get(player);
  if (!state || state.track !== track || state.identity !== trackIdentity(track)) {
    state = { track, identity: trackIdentity(track), voters: new Set() }; votes.set(player, state);
  }
  for (const id of state.voters) if (!humans.has(id)) state.voters.delete(id);
  const duplicate = state.voters.has(userId);
  state.voters.add(userId);
  const needed = Math.floor(humans.size / 2) + 1;
  return { duplicate, count: state.voters.size, needed, passed: state.voters.size >= needed, track };
}
export async function voteToSkip(player, userId, humanIds, client = null) {
  const result = recordSkipVote(player, userId, humanIds);
  if (result.passed) { votes.delete(player); await skipCurrent(player, client); }
  return result;
}
