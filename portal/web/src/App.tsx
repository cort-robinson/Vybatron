import { useEffect, useState } from 'react';
import { ArrowClockwiseIcon, ArrowRightIcon, CaretDownIcon, DiscordLogoIcon, GearSixIcon, HeartIcon, MagnifyingGlassIcon, MusicNotesIcon, PlusIcon, UsersIcon, WarningCircleIcon, WaveformIcon, WifiSlashIcon, XIcon } from '@phosphor-icons/react';
import type { Surface } from './types';
import { usePortal } from './usePortal';
import { publicUrl } from './api';
import { statusLabel } from './format';
import { Avatar, Empty, ErrorState, IconButton, Loading } from './components/ui';
import { Player } from './components/Player';
import { Queue } from './components/Queue';
import { Search } from './components/Search';
import { LibraryView } from './components/Library';
import { ServerView, type AmbientMode, type InstallPrompt } from './components/Server';
import { Recovery } from './components/Recovery';

function initialAmbient(): AmbientMode {
  try { const value = localStorage.getItem('vybertron.ambient'); return value === 'off' || value === 'subtle' || value === 'on' ? value : 'on'; } catch { return 'on'; }
}
const surfaces: { id: Surface; label: string; icon: typeof MusicNotesIcon }[] = [
  { id: 'session', label: 'Session', icon: MusicNotesIcon }, { id: 'music', label: 'My Music', icon: HeartIcon }, { id: 'server', label: 'Server', icon: UsersIcon },
];

export function App() {
  const portal = usePortal();
  const [surface, setSurface] = useState<Surface>('session');
  const [expanded, setExpanded] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [ambient, changeAmbient] = useState<AmbientMode>(initialAmbient);
  const [hidden, setHidden] = useState(document.hidden);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [update, setUpdate] = useState<ServiceWorker | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const { bootstrap, snapshot, connection, auth } = portal;
  useEffect(() => {
    const change = () => setHidden(document.hidden); const media = matchMedia('(prefers-reduced-motion: reduce)'); const motionChange = () => setReduced(media.matches);
    document.addEventListener('visibilitychange', change); media.addEventListener('change', motionChange);
    const install = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt); };
    const installed = () => { setInstallPrompt(null); portal.notify('Vybertron is ready on your home screen.', 'success'); };
    window.addEventListener('beforeinstallprompt', install); window.addEventListener('appinstalled', installed);
    return () => { document.removeEventListener('visibilitychange', change); media.removeEventListener('change', motionChange); window.removeEventListener('beforeinstallprompt', install); window.removeEventListener('appinstalled', installed); };
  }, [portal.notify]);
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    let active = true;
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(registration => {
      if (!active) return;
      if (registration.waiting) setUpdate(registration.waiting);
      registration.addEventListener('updatefound', () => { const worker = registration.installing; worker?.addEventListener('statechange', () => { if (active && worker.state === 'installed' && navigator.serviceWorker.controller) setUpdate(worker); }); });
    }).catch(() => { /* Live portal remains usable if installation is unavailable. */ });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (auth !== 'ready') { setExpanded(false); setSearchOpen(false); setQuery(''); setAccountOpen(false); }
  }, [auth]);
  const setAmbient = (value: AmbientMode) => { changeAmbient(value); try { localStorage.setItem('vybertron.ambient', value); } catch { /* Optional, non-sensitive preference. */ } };
  const navigate = (value: Surface) => { setSurface(value); setExpanded(false); setAccountOpen(false); };
  const openSearch = () => setSearchOpen(true);
  const install = () => { if (installPrompt) void installPrompt.prompt().then(() => installPrompt.userChoice).then(() => setInstallPrompt(null)).catch(() => portal.notify('Use your browser’s Install app option to try again.')); };
  const motion = ambient !== 'off' && !reduced && !hidden && connection === 'live' && snapshot?.session.status === 'playing';
  const artwork = publicUrl(snapshot?.session.current?.artworkUrl);
  const background = <div className={`ambient-scene ${expanded ? 'immersive' : ''} ${motion ? 'moving' : 'settled'} ${ambient === 'subtle' ? 'subtle' : ''} ${ambient === 'off' ? 'disabled' : ''}`} aria-hidden="true">
    <img className="aurora-field" src="/assets/aurora.png" alt="" />{artwork && <img className="artwork-field" src={artwork} alt="" referrerPolicy="no-referrer" />}
  </div>;
  if (auth === 'loading') return <div className="auth-page">{background}<Brand /><Loading label="Finding your listening space…" /></div>;
  if (auth === 'signed-out' || auth === 'error') return <div className="auth-page">{background}<Brand /><main className="sign-in"><div className="signin-sleeve"><img src="/assets/fallback-cover.png" alt="" /></div><h1>A better vibe together.</h1><p>Your shared queue. Your favorite songs.<br />A listening space for your Discord server.</p>{auth === 'error' ? <ErrorState message={portal.authError} retry={() => void portal.loadBootstrap()} /> : <a className="button primary discord-signin" href="/auth/discord"><DiscordLogoIcon size={25} weight="fill" />Continue with Discord<ArrowRightIcon size={20} /></a>}<span className="signin-footnote">Audio stays in Discord. Bring the good taste.</span></main><footer className="auth-footer">Vybertron · Made for listening together</footer></div>;
  const viewer = bootstrap!.viewer;
  const noGuilds = !bootstrap!.guilds.length;
  const heading = surface === 'session' ? 'Shared Queue' : surface === 'music' ? 'My Music' : 'Your Server';
  return <div className={`app-shell ${expanded ? 'player-open' : ''} ${connection !== 'live' ? 'has-connection-notice' : ''}`}>{background}<a href="#main-content" className="skip-link">Skip to content</a>
    <aside className="sidebar"><Brand /><div className="guild-card"><div className="guild-icon">{snapshot?.guild.iconUrl || bootstrap!.guilds.find(g => g.id === portal.guildId)?.iconUrl ? <img src={publicUrl(snapshot?.guild.iconUrl || bootstrap!.guilds.find(g => g.id === portal.guildId)?.iconUrl)} alt="" /> : <DiscordLogoIcon size={26} weight="fill" />}</div><div className="guild-info"><label className="sr-only" htmlFor="guild">Server</label><select id="guild" aria-label="Server" value={portal.guildId} disabled={noGuilds} onChange={event => { portal.selectGuild(event.target.value); setExpanded(false); }}><option value="" disabled>Select server</option>{bootstrap!.guilds.map(guild => <option key={guild.id} value={guild.id}>{guild.name}</option>)}</select><span className="guild-channel">{snapshot?.session.textChannel ? `# ${snapshot.session.textChannel.name}` : 'Your listening space'}</span><span className={`guild-status ${snapshot?.session.status || 'idle'}`}><span className="status-dot" />{statusLabel(snapshot)}</span></div><CaretDownIcon className="guild-caret" size={16} /></div>
      <nav className="navigation" aria-label="Main navigation">{surfaces.map(item => <button key={item.id} className={surface === item.id ? 'selected' : ''} aria-current={surface === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><item.icon size={26} /><span>{item.label}</span></button>)}</nav>
      <div className="sidebar-session">{snapshot?.session.voiceChannel && <><span>Listening room</span><strong><UsersIcon size={17} />{snapshot.session.voiceChannel.name}</strong>{snapshot.session.listeners.length > 0 && <div className="listeners"><div>{snapshot.session.listeners.slice(0, 5).map(listener => <Avatar key={listener.id} url={listener.avatarUrl} name={listener.displayName} />)}</div><span>{snapshot.session.listeners.length} listening</span></div>}</>}</div>
      <div className="account"><button className="account-identity" aria-expanded={accountOpen} aria-label="Account options" onClick={() => setAccountOpen(!accountOpen)}><Avatar url={viewer.avatarUrl} name={viewer.displayName} /><span><strong>{viewer.displayName}</strong><small>{viewer.maintainer ? 'Maintainer' : snapshot?.session.canAdd ? 'In voice' : 'Signed in'}</small></span></button><IconButton label="Open settings" onClick={() => navigate('server')}><GearSixIcon size={23} weight="fill" /></IconButton>{accountOpen && <div className="menu-panel account-menu"><p>{viewer.displayName}</p><button onClick={() => navigate('server')}>Settings & appearance</button><button onClick={() => void portal.logout()}>Sign out on this device</button></div>}</div>
    </aside>
    <div className="portal-main"><header className={`topbar ${expanded ? 'sleeve-topbar' : ''}`}><div className="page-title"><h1>{heading}</h1><p>{surface === 'session' ? 'A better vibe together' : surface === 'music' ? 'The songs you keep coming back to' : 'Make this space your own'}</p></div><div className="topbar-actions"><label className="header-search"><MagnifyingGlassIcon size={21} /><span className="sr-only">Search music</span><input value={query} onChange={event => { setQuery(event.target.value); setSearchOpen(true); }} onFocus={openSearch} placeholder="Search for songs, artists, or albums…" type="search" aria-label="Search music" /></label><button className="button primary" disabled={noGuilds} onClick={openSearch}><PlusIcon size={23} /><span>Add music</span></button></div></header>
      {!noGuilds && connection !== 'live' && <aside className={`connection-banner ${connection === 'offline' ? 'offline' : ''}`} role="status">{connection === 'offline' ? <WifiSlashIcon size={21} /> : <span className="spinner" />}<div><strong>{connection === 'offline' ? 'Live updates paused' : 'Getting fresh state'}</strong><span>{connection === 'offline' ? portal.connectionError || 'Reconnect before making changes. Discord playback continues.' : 'Controls return once the current session is verified.'}</span></div>{connection === 'offline' && <button className="text-button" onClick={portal.reconnect}><ArrowClockwiseIcon size={18} />Reconnect</button>}</aside>}
      <main id="main-content" tabIndex={-1} className="page-content" hidden={expanded}>{noGuilds ? <Empty title="No listening spaces available" description="Sign in with an account that belongs to a server where Vybertron is installed. The portal does not offer public bot installation." action={<button className="button secondary" onClick={() => void portal.loadBootstrap()}><ArrowClockwiseIcon size={18} />Refresh access</button>} /> : !snapshot ? connection === 'offline' ? <ErrorState message={portal.connectionError} retry={portal.reconnect} /> : <Loading /> : <>
        <div hidden={surface !== 'session'}><Recovery portal={portal} />{snapshot.session.reason && <div className="permission-note"><WarningCircleIcon size={20} /><span>{snapshot.session.reason}</span></div>}<Queue portal={portal} onAdd={openSearch} /><div className="session-options"><button className={`text-button ${snapshot.session.radio ? 'active-control' : ''}`} disabled={!portal.can('control') || !!portal.pending.length || !snapshot.session.current} onClick={() => void portal.run({ command: 'radio', subcommand: snapshot.session.radio ? 'off' : 'on', expectedRevision: snapshot.revision }, 'control')}>Artist radio: {snapshot.session.radio ? 'on' : 'off'}</button><span>{snapshot.session.radio ? 'Fresh songs when the queue ends' : 'Keep discovery on your terms'}</span><button className="text-button" disabled={!portal.can('vote') || !!portal.pending.length || !snapshot.session.current} onClick={() => void portal.run({ command: 'voteskip', expectedRevision: snapshot.revision }, 'vote')}>Vote to skip</button></div></div>
        <div hidden={surface !== 'music'}><LibraryView portal={portal} /></div>
        <div hidden={surface !== 'server'}><ServerView portal={portal} ambient={ambient} setAmbient={setAmbient} installPrompt={installPrompt} install={install} /></div>
      </>}</main>
    </div>
    {!noGuilds && <Player portal={portal} expanded={expanded} setExpanded={setExpanded} onAdd={openSearch} />}
    <Search portal={portal} open={searchOpen} onClose={() => setSearchOpen(false)} query={query} setQuery={setQuery} />
    {portal.notice && !searchOpen && <div className={`toast ${portal.notice.kind}`} role={portal.notice.kind === 'error' ? 'alert' : 'status'}><span>{portal.notice.message}</span><IconButton label="Dismiss notification" onClick={portal.dismissNotice}><XIcon size={19} /></IconButton></div>}
    {update && <div className="update-notice"><span>A fresh version of Vybertron is ready.</span><button className="text-button" onClick={() => { navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true }); update.postMessage({ type: 'ACTIVATE' }); }}>Update app</button></div>}
  </div>;
}
function Brand() { return <div className="brand"><WaveformIcon size={34} aria-hidden="true" /><span>Vybertron</span></div>; }
