import type { GuildSnapshot } from './types';
export function time(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  return `${h ? `${h}:` : ''}${h ? String(Math.floor(seconds / 60) % 60).padStart(2, '0') : Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function timestamp(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
export function totalTime(ms: number): string { return ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)} hr ${Math.round(ms % 3_600_000 / 60_000)} min` : `${Math.round(ms / 60_000)} min`; }
export function date(at: number): string { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at); }
export function statusLabel(snapshot: GuildSnapshot | null): string {
  if (!snapshot) return 'Connecting';
  return { idle: 'Ready to listen', playing: 'Listening in Discord', paused: 'Paused in Discord', recovering: 'Recovering playback', unavailable: 'Playback unavailable' }[snapshot.session.status];
}
