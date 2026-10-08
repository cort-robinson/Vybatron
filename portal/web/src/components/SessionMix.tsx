import { useId, useRef, useState, type RefObject } from 'react';
import type { Portal } from '../usePortal';
import { Dialog } from './ui';

const mixKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
const validName = (value: string) => /^[a-z0-9][a-z0-9 _-]{0,39}$/.test(mixKey(value));
export const SESSION_MIX_DETAIL = 'Saves the songs already played this session, then the current song and the queue, as a shared mix for this server. A mix holds up to 100 songs; when it’s full, the earliest played songs are left out.';

// One name field shared by the standalone save and the Stop confirmation.
function useSessionMix(portal: Portal) {
  const { library, snapshot, can, pending, run } = portal;
  const [name, setName] = useState('');
  const existing = library?.mixes.find(mix => mixKey(mix.name) === mixKey(name));
  const problem = !name.trim() ? '' : !validName(name) ? 'Use 1–40 letters, numbers, spaces, hyphens or underscores.'
    : existing ? existing.canEdit ? `“${existing.name}” already exists. Choose a new name, or replace it from My Music.` : `“${existing.name}” belongs to another listener. Choose a new name.` : '';
  const ready = !!name.trim() && !problem && can('library') && !!snapshot?.session.current && !pending.length;
  const save = () => run({ command: 'mix', subcommand: 'save', options: { name: name.trim(), session: true }, expectedRevision: snapshot?.revision }, 'library');
  return { name, setName, problem, ready, save };
}

function NameField({ id, mix, hintId, inputRef }: { id: string; mix: ReturnType<typeof useSessionMix>; hintId: string; inputRef?: RefObject<HTMLInputElement | null> }) {
  return <label className="session-mix-field" htmlFor={id}>Mix name
    <input ref={inputRef} id={id} value={mix.name} dir="auto" maxLength={40} placeholder="Friday night" autoComplete="off" aria-describedby={hintId} aria-invalid={!!mix.problem || undefined}
      onChange={event => mix.setName(event.target.value)} />
    <span id={hintId} className={mix.problem ? 'field-hint error-text' : 'field-hint'} role={mix.problem ? 'alert' : undefined}>{mix.problem || SESSION_MIX_DETAIL}</span>
  </label>;
}

export function SaveSessionDialog({ portal, onClose }: { portal: Portal; onClose: () => void }) {
  const mix = useSessionMix(portal);
  const id = useId(); const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  return <Dialog title="Save this session as a mix" onClose={onClose} className="confirm-dialog session-mix-dialog" initialFocusRef={input}>
    <form onSubmit={event => { event.preventDefault(); if (mix.ready) void mix.save().then(ok => { if (ok) onClose(); }); }}>
      <NameField id={id} mix={mix} hintId={hintId} inputRef={input} />
      <div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button>
        <button className="button primary" disabled={!mix.ready}>{portal.pending.includes('mix:save') ? 'Saving…' : 'Save mix'}</button></div>
    </form>
  </Dialog>;
}

// Stop discards the session, so the confirmation offers to keep it as a mix first.
export function StopDialog({ portal, onClose }: { portal: Portal; onClose: () => void }) {
  const mix = useSessionMix(portal);
  const id = useId(); const hintId = useId();
  const stopping = portal.pending.includes('stop:');
  const stop = () => portal.run({ command: 'stop' }, 'control').then(ok => { if (ok) onClose(); });
  return <Dialog title="Stop this listening session?" onClose={onClose} className="confirm-dialog stop-dialog">
    <p>Stops playback in Discord, clears the queue, and discards the saved checkpoint. Your favorites and shared mixes stay saved.</p>
    <div className="stop-keep"><h3>Keep this session</h3><NameField id={id} mix={mix} hintId={hintId} /></div>
    <div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button>
      <button type="button" className="button secondary" disabled={!mix.ready || stopping} onClick={() => void mix.save().then(ok => { if (ok) void stop(); })}>Save mix, then stop</button>
      <button type="button" className="button danger" disabled={stopping} onClick={() => void stop()}>{stopping ? 'Working…' : 'Stop and discard'}</button></div>
  </Dialog>;
}
