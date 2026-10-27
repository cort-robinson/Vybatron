import { useSyncExternalStore } from 'react';
import type { GuildSnapshot } from './types';

// The position advances locally between snapshots while a song plays. One shared clock ticks only
// while something shows a moving position, and only those readouts re-render on each tick, not
// the whole player twice a second.
const ticks = new Set<() => void>();
let now = Date.now(); let ticker: ReturnType<typeof setInterval> | undefined;
const tick = () => { now = Date.now(); ticks.forEach(listener => listener()); };
const resume = () => { clearInterval(ticker); ticker = undefined; if (!document.hidden && ticks.size) { tick(); ticker = setInterval(tick, 500); } };
function subscribe(listener: () => void) {
  ticks.add(listener);
  if (ticks.size === 1) { document.addEventListener('visibilitychange', resume); resume(); }
  return () => { ticks.delete(listener); if (!ticks.size) { document.removeEventListener('visibilitychange', resume); clearInterval(ticker); ticker = undefined; } };
}
const still = () => () => {};
export type Clock = { session: GuildSnapshot['session'] | undefined; receivedAt: number; live: boolean };
// With no current song there is no timeline, whatever position an idle snapshot still carries.
export function usePosition({ session, receivedAt, live }: Clock) {
  const track = session?.current;
  const moving = !!track && session.status === 'playing' && live;
  const clock = useSyncExternalStore(moving ? subscribe : still, () => moving ? now : 0);
  if (!track) return 0;
  const duration = session.durationMs || track.durationMs || 0;
  return Math.min(duration || Infinity, Math.max(0, (session.positionMs || 0) + (moving ? Math.max(0, clock - receivedAt) : 0)));
}
