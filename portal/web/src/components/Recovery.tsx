import { useState } from 'react';
import { ArrowCounterClockwiseIcon, BookmarkSimpleIcon } from '@phosphor-icons/react';
import type { Portal } from '../usePortal';
import { date, time } from '../format';
import { Confirm } from './ui';

export function Recovery({ portal }: { portal: Portal }) {
  const [discard, setDiscard] = useState(false);
  const saved = portal.snapshot?.savedSession;
  if (!saved?.exists || portal.snapshot?.session.status === 'playing' || portal.snapshot?.session.status === 'paused') return null;
  const discardCapability = portal.can('control') ? 'control' : portal.can('resume') ? 'resume' : 'admin';
  return <aside className="recovery-banner" aria-label="Saved listening session"><BookmarkSimpleIcon size={27} /><div><h2>Pick up where you left off</h2><p>{saved.trackCount} {saved.trackCount === 1 ? 'song' : 'songs'}{saved.voiceChannel ? ` in ${saved.voiceChannel.name}` : ''} · {time(saved.positionMs)}{saved.paused ? ' · paused' : ''}{saved.savedAt ? ` · saved ${date(saved.savedAt)}` : ''}</p></div><div className="recovery-actions"><button className="button secondary" disabled={!portal.can('resume') || !!portal.pending.length} title={!portal.can('resume') ? 'Join the saved voice channel to restore this session.' : undefined} onClick={() => void portal.run({ command: 'session', subcommand: 'resume', expectedRevision: portal.snapshot?.revision }, 'resume')}><ArrowCounterClockwiseIcon size={18} />Resume session</button><button className="text-button" disabled={!portal.can(discardCapability) || !!portal.pending.length} onClick={() => setDiscard(true)}>Discard</button></div>{discard && <Confirm title="Discard the saved session?" detail="Removes the checkpoint. This saved session will no longer be available to resume." action="Discard session" onClose={() => setDiscard(false)} busy={!!portal.pending.length} onConfirm={() => { void portal.run({ command: 'session', subcommand: 'discard', expectedRevision: portal.snapshot?.revision }, discardCapability).then(ok => { if (ok) setDiscard(false); }); }} />}</aside>;
}
