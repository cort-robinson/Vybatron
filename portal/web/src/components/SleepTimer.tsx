import { useEffect, useId, useRef, useState } from 'react';
import type { Portal } from '../usePortal';
import type { SleepTimer } from '../types';
import { Dialog } from './ui';

export const SLEEP_MINUTES = { min: 1, max: 720 };
const PRESETS = [15, 30, 60, 90];
const duration = (minutes: number) => minutes >= 60 ? `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`;

export function sleepText(sleep: SleepTimer | null | undefined, now = Date.now()): string | null {
  if (!sleep) return null;
  if (sleep.mode === 'track') return 'Stops after this song';
  return `Stops in ${duration(Math.max(1, Math.ceil((sleep.endsAt - now) / 60_000)))}`;
}

// The countdown is shown in whole minutes, so a coarse tick keeps it current.
export function useSleepText(sleep: SleepTimer | null | undefined) {
  const [now, setNow] = useState(Date.now);
  // Keyed on the timer's values: every live frame brings an equal timer in a new object.
  const endsAt = sleep?.mode === 'time' ? sleep.endsAt : null;
  useEffect(() => {
    setNow(Date.now());
    if (endsAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [sleep?.mode, endsAt]);
  return sleepText(sleep, now);
}

export function SleepDialog({ portal, onClose }: { portal: Portal; onClose: () => void }) {
  const session = portal.snapshot?.session;
  const sleep = session?.sleep;
  const status = useSleepText(sleep);
  const [minutes, setMinutes] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const id = useId(); const hintId = useId();
  const value = Number(minutes);
  const valid = minutes.trim() !== '' && Number.isInteger(value) && value >= SLEEP_MINUTES.min && value <= SLEEP_MINUTES.max;
  const busy = portal.pending.some(key => key.startsWith('sleep:'));
  const allowed = portal.can('control') && !busy;
  const track = session?.current;
  const send = (subcommand: string, options?: { minutes: number }) => portal.run({ command: 'sleep', subcommand, ...(options ? { options } : {}) }, 'control').then(ok => { if (ok) onClose(); });
  return <Dialog title="Sleep timer" onClose={onClose} className="confirm-dialog sleep-dialog">
    <p>{status ? `${status}. ` : ''}When the timer ends, playback stops for everyone in the voice channel, the queue is cleared and Vybatron leaves, the same as Stop.</p>
    <div className="sleep-options" role="group" aria-label="Stop playback">
      <button type="button" className="button secondary sleep-after" aria-pressed={sleep?.mode === 'track'} disabled={!allowed || !track || track.isStream} title={track?.isStream ? 'A live stream has no end.' : undefined}
        onClick={() => void send('after-track')}>When this song ends</button>
      {PRESETS.map(preset => <button key={preset} type="button" className="button secondary" disabled={!allowed} onClick={() => void send('in', { minutes: preset })}>In {duration(preset)}</button>)}
    </div>
    <form className="sleep-custom" onSubmit={event => { event.preventDefault(); if (valid && allowed) void send('in', { minutes: value }); }}>
      <label htmlFor={id}>Other time</label>
      <div className="sleep-custom-row"><input ref={input} id={id} type="number" inputMode="numeric" min={SLEEP_MINUTES.min} max={SLEEP_MINUTES.max} step={1} value={minutes} placeholder="Minutes"
        aria-describedby={hintId} aria-invalid={minutes.trim() !== '' && !valid || undefined} onChange={event => setMinutes(event.target.value)} />
        <button className="button primary" disabled={!valid || !allowed}>Set timer</button></div>
      <span id={hintId} className={minutes.trim() !== '' && !valid ? 'field-hint error-text' : 'field-hint'}>Whole minutes from {SLEEP_MINUTES.min} to {SLEEP_MINUTES.max} (12 hours).</span>
    </form>
    <div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>Close</button>
      {sleep && <button type="button" className="button danger" disabled={!allowed} onClick={() => void send('cancel')}>Turn off timer</button>}</div>
  </Dialog>;
}
