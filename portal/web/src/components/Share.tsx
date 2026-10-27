import { useEffect, useState } from 'react';
import { ArrowClockwiseIcon, LinkIcon, PlusIcon } from '../icons';
import type { Portal } from '../usePortal';
import { Dialog } from './ui';

// A link shared to the installed app. Nothing is queued until the listener confirms
// the server and taps Add to queue.
export function ShareDialog({ portal, link, onClose }: { portal: Portal; link: string | null; onClose: () => void }) {
  const guilds = portal.bootstrap?.guilds || [];
  const voiceGuild = portal.bootstrap?.voiceGuildId;
  // One server is the only choice. With several, the one you're in voice in is the
  // obvious one; otherwise the listener picks.
  const [chosen, setChosen] = useState(() => guilds.length === 1 ? guilds[0].id : guilds.some(guild => guild.id === voiceGuild) ? voiceGuild! : '');
  const [busy, setBusy] = useState(false);
  // The portal follows the chosen server, so its live state answers whether it can be added.
  // selectGuild ignores the server already showing.
  useEffect(() => { if (chosen) portal.selectGuild(chosen); }, [chosen]);
  const close = <div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>Close</button></div>;
  if (!link) return <Dialog title="Add shared link" onClose={onClose} className="confirm-dialog share-dialog">
    <p>That share has no YouTube, YouTube Music, Spotify or SoundCloud link.</p>{close}
  </Dialog>;
  if (!guilds.length) return <Dialog title="Add shared link" onClose={onClose} className="confirm-dialog share-dialog">
    <p>Vybatron isn’t in any of your servers, so there’s no queue to add this link to.</p>{close}
  </Dialog>;
  const name = guilds.find(guild => guild.id === chosen)?.name || 'this server';
  const ready = !!chosen && portal.guildId === chosen && portal.snapshot?.guild.id === chosen && portal.connection === 'live';
  const session = portal.snapshot?.session;
  const allowed = ready && portal.can('add');
  // Where the song would play, said before anything is added.
  const destination = !chosen ? 'Choose the server whose queue gets this link.'
    : !ready ? portal.connection === 'offline' ? portal.connectionError || `${name} is unavailable right now. Reconnect to try again.` : `Checking ${name}…`
    : !allowed ? null
    : portal.target === 'local' ? `You’re not in a voice channel in ${name}, so this plays on this device.`
    : session?.voiceChannel && session.current ? `Adds to the queue playing in ${session.voiceChannel.name}.`
    : `Nothing is playing in ${name} right now. Vybatron joins ${session?.viewerVoice?.name || 'your voice channel'} to play it.`;
  const add = async () => {
    setBusy(true);
    try { if (await portal.run({ command: 'play', options: { query: link } }, 'add')) onClose(); }
    finally { setBusy(false); }
  };
  return <Dialog title="Add shared link" onClose={onClose} className="confirm-dialog share-dialog">
    <p className="share-link"><LinkIcon size={18} aria-hidden="true" /><span>{link}</span></p>
    {guilds.length > 1 && <label className="share-server"><span>Server</span><select value={chosen} onChange={event => setChosen(event.target.value)}>
      {!chosen && <option value="" disabled>Choose a server</option>}{guilds.map(guild => <option key={guild.id} value={guild.id}>{guild.name}</option>)}</select></label>}
    {destination && <p role="status">{destination}</p>}
    {ready && !allowed && <p className="permission-note">{portal.blockedReason}</p>}
    {portal.notice?.kind === 'error' && <p className="notice-line warm-text" role="alert">{portal.notice.message}</p>}
    <div className="form-actions">{chosen && portal.connection === 'offline' && <button type="button" className="text-button" onClick={portal.reconnect}><ArrowClockwiseIcon size={18} />Reconnect</button>}
      <button type="button" className="button secondary" onClick={onClose}>Cancel</button>
      <button type="button" className="button primary" disabled={!allowed || busy} onClick={() => void add()}>{busy ? <span className="spinner" /> : <PlusIcon size={19} />}Add to queue</button></div>
  </Dialog>;
}
