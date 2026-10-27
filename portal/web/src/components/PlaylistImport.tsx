import { useState } from 'react';
import { DownloadSimpleIcon } from '../icons';
import type { Portal } from '../playback';
import type { ImportPreview } from '../types';
import { Dialog } from './ui';

const mixKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
const songs = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'song' : 'songs'}`;
const supported = (value: string) => {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && /(^|\.)(youtube\.com|youtu\.be|soundcloud\.com|spotify\.com)$/i.test(url.hostname);
  } catch { return false; }
};

// Paste a public playlist link, review what would be saved, then confirm.
export function PlaylistImport({ portal, target }: { portal: Portal; target: 'favorites' | 'mix' }) {
  const [link, setLink] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{ value: ImportPreview; link: string; name: string } | null>(null);
  const { library, can, pending } = portal;
  const editable = can('library') && !pending.length;
  const existing = target === 'mix' ? library?.mixes.find(mix => mixKey(mix.name) === mixKey(name)) : undefined;
  const locked = !!existing && !existing.canEdit;
  const ready = editable && !loading && supported(link) && (target === 'favorites' || (!!name.trim() && !locked));
  const command = (draft: { link: string; name: string }) => ({ command: target === 'favorites' ? 'favorite' : 'mix', subcommand: 'import',
    options: { link: draft.link, ...(target === 'mix' && { name: draft.name }) } });

  const lookUp = async () => {
    const draft = { link: link.trim(), name: name.trim() };
    setLoading(true);
    try {
      const value = await portal.previewImport(command(draft));
      if (value) setPreview({ value, ...draft });
    } finally { setLoading(false); }
  };
  const confirm = async () => {
    if (!preview?.value.id) return;
    if (await portal.run({ ...command(preview), expectedImportId: preview.value.id }, 'library')) {
      setPreview(null); setLink(''); if (target === 'mix') setName('');
    }
  };
  const note = locked ? 'That mix belongs to another listener. Choose a new name, or ask its creator or a server manager.'
    : target === 'favorites' ? 'Paste a public YouTube, YouTube Music, Spotify or SoundCloud playlist. You’ll see what will be saved before anything changes. Up to 100 songs per import.'
    : existing ? `Adds new songs to “${existing.name}”, up to 100 songs in the mix.` : 'Creates a shared mix from a public playlist, up to 100 songs.';

  return <>
    <form className="mix-save-form playlist-import-form" onSubmit={event => { event.preventDefault(); if (ready) void lookUp(); }}>
      {target === 'mix' && <label>Mix name<input value={name} dir="auto" maxLength={40} placeholder="Road trip" onChange={event => setName(event.target.value)} /></label>}
      <label>{target === 'favorites' ? 'Import a playlist' : 'Playlist link'}<input type="url" inputMode="url" value={link} maxLength={200} placeholder="https://music.youtube.com/playlist?list=…" onChange={event => setLink(event.target.value)} /></label>
      <button className="button secondary" disabled={!ready}><DownloadSimpleIcon size={20} />{loading ? 'Looking up…' : 'Preview import'}</button>
    </form>
    <p className="library-note">{loading ? 'Looking up the playlist. Large Spotify playlists can take up to a minute.' : note}</p>
    {preview && <ImportDialog preview={preview.value} busy={!editable} onClose={() => setPreview(null)} onConfirm={() => void confirm()} />}
  </>;
}

function ImportDialog({ preview, busy, onClose, onConfirm }: { preview: ImportPreview; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const where = preview.target === 'favorites' ? 'your favorites' : `“${preview.name}”`;
  const counts: [string, number][] = [['Will be added', preview.toAdd], ['Already saved', preview.duplicates], ['Not matched', preview.unmatched],
    [`Over the ${preview.limit.toLocaleString()}-song limit`, preview.overLimit]];
  return <Dialog title={`Import ${preview.title}`} onClose={onClose} className="confirm-dialog import-dialog">
    <p>{songs(preview.found)} found. {preview.toAdd ? `${songs(preview.toAdd)} will be added to ${where}.` : `Nothing new to add to ${where}.`}</p>
    <dl className="import-counts">{counts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value.toLocaleString()}</dd></div>)}</dl>
    {preview.notes.map(line => <p key={line} className="library-note">{line}</p>)}
    {preview.tracks.length > 0 && <ol className="import-tracks" aria-label="Songs to add">{preview.tracks.map((track, index) => <li key={index}><strong dir="auto">{track.title}</strong><span dir="auto">{track.author}</span></li>)}</ol>}
    <div className="form-actions">
      <button className="button secondary" onClick={onClose}>{preview.id ? 'Cancel' : 'Close'}</button>
      {preview.id && <button className="button primary" disabled={busy} onClick={onConfirm}>{busy ? 'Working…' : `Add ${songs(preview.toAdd)}`}</button>}
    </div>
  </Dialog>;
}
