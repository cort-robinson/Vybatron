import { useEffect, useRef, useState } from 'react';
import { ArrowClockwiseIcon, ArrowRightIcon, CaretDownIcon, DiscordLogoIcon, GearSixIcon, HeartIcon, MagnifyingGlassIcon, MusicNotesIcon, PlusIcon, UsersIcon, WarningCircleIcon, WaveformIcon, WifiSlashIcon, XIcon } from '@phosphor-icons/react';
import type { Surface } from './types';
import { usePortal } from './usePortal';
import { publicUrl } from './api';
import { useArtPalette } from './art';
import { Spectrum } from './components/Spectrum';
import { statusLabel } from './format';
import { ActionPopover, Avatar, Empty, ErrorState, FallbackCover, IconButton, Loading } from './components/ui';
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
  const navigationState = useRef({ surface, expanded });
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
    if (auth !== 'ready') { setExpanded(false); setSearchOpen(false); setQuery(''); }
  }, [auth]);
  useEffect(() => {
    const previous = navigationState.current;
    navigationState.current = { surface, expanded };
    if (previous.surface !== surface) document.getElementById('main-content')?.focus();
  }, [surface, expanded]);
  // Confirmations clear themselves; errors stay until dismissed.
  const dismissNotice = useRef(portal.dismissNotice); dismissNotice.current = portal.dismissNotice;
  useEffect(() => {
    if (!portal.notice || portal.notice.kind === 'error') return;
    const timer = setTimeout(() => dismissNotice.current(), 4500);
    return () => clearTimeout(timer);
  }, [portal.notice]);
  const setAmbient = (value: AmbientMode) => { changeAmbient(value); try { localStorage.setItem('vybertron.ambient', value); } catch { /* Optional, non-sensitive preference. */ } };
  const navigate = (value: Surface) => { setSurface(value); setExpanded(false); };
  const openSearch = () => setSearchOpen(true);
  const install = () => { if (installPrompt) void installPrompt.prompt().then(() => installPrompt.userChoice).then(() => setInstallPrompt(null)).catch(() => portal.notify('Use your browser’s Install app option to try again.')); };
  const motion = ambient !== 'off' && !reduced && !hidden && connection === 'live' && snapshot?.session.status === 'playing';
  const artwork = publicUrl(snapshot?.session.current?.artworkUrl);
  const palette = useArtPalette(artwork);
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--accent', palette.accent); root.setProperty('--ground', palette.ground);
    palette.glow.forEach((color, index) => root.setProperty(`--glow-${index + 1}`, color));
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.ground);
  }, [palette]);
  const background = <div className={`ambient-scene ${expanded ? 'immersive' : ''} ${motion ? 'moving' : 'settled'} ${ambient === 'subtle' ? 'subtle' : ''} ${ambient === 'off' ? 'disabled' : ''}`} aria-hidden="true">
    <div className="room-light"><span className="light light-1" /><span className="light light-2" /><span className="light light-3" /></div>
    {artwork && <img className="artwork-field" src={artwork} alt="" referrerPolicy="no-referrer" />}
  </div>;
  if (auth === 'loading') return <div className="auth-page">{background}<Brand /><Loading label="Finding your listening space…" /></div>;
  if (auth === 'signed-out' || auth === 'error') return <div className="auth-page">{background}<Brand /><main className="sign-in"><div className="signin-sleeve"><FallbackCover /></div><Spectrum className="signin-spectrum" seed="vybertron" color={palette.accent} mode="playing" animate={ambient !== 'off' && !reduced && !hidden} bands={36} /><h1>A better vibe together.</h1><p>Your shared queue and favorite songs,<br />controlled from any screen in your Discord server.</p>{auth === 'error' ? <ErrorState message={portal.authError} retry={() => void portal.loadBootstrap()} /> : <a className="button primary discord-signin" href="/auth/discord"><DiscordLogoIcon size={25} weight="fill" />Continue with Discord<ArrowRightIcon size={20} /></a>}<span className="signin-footnote">Audio plays in Discord, never in this browser.</span></main><footer className="auth-footer">Vybertron · Made for listening together</footer></div>;
  const viewer = bootstrap!.viewer;
  const noGuilds = !bootstrap!.guilds.length;
  const heading = surface === 'session' ? 'Shared Queue' : surface === 'music' ? 'My Music' : 'Your Server';
  const room = snapshot?.session.voiceChannel; const listening = snapshot?.session.listeners.length || 0;
  const subtitle = surface === 'session' ? room ? `Live in ${room.name}${listening ? ` · ${listening} listening` : ''}` : 'Nobody is listening in voice yet'
    : surface === 'music' ? 'Favorites, shared mixes, and recent plays' : 'Preferences, defaults, and health';
  return <div className={`app-shell ${expanded ? 'player-open' : ''} ${connection !== 'live' ? 'has-connection-notice' : ''}`}>{background}<a href="#main-content" className="skip-link">Skip to content</a>
    <aside className="sidebar"><Brand /><div className="guild-card"><div className="guild-icon">{snapshot?.guild.iconUrl || bootstrap!.guilds.find(g => g.id === portal.guildId)?.iconUrl ? <img src={publicUrl(snapshot?.guild.iconUrl || bootstrap!.guilds.find(g => g.id === portal.guildId)?.iconUrl)} alt="" /> : <DiscordLogoIcon size={26} weight="fill" />}</div><div className="guild-info"><label className="sr-only" htmlFor="guild">Server</label><select id="guild" aria-label="Server" value={portal.guildId} disabled={noGuilds} onChange={event => { portal.selectGuild(event.target.value); setExpanded(false); }}><option value="" disabled>Select server</option>{bootstrap!.guilds.map(guild => <option key={guild.id} value={guild.id}>{guild.name}</option>)}</select><span className="guild-channel">{snapshot?.session.voiceChannel ? `Voice: ${snapshot.session.voiceChannel.name}` : snapshot?.savedSession.voiceChannel ? `Saved: ${snapshot.savedSession.voiceChannel.name}` : 'Join a voice channel'}</span><span className={`guild-status ${snapshot?.session.status || 'idle'}`}><span className="status-dot" />{statusLabel(snapshot)}</span></div><CaretDownIcon className="guild-caret" size={16} /></div>
      <nav className="navigation" aria-label="Main navigation">{surfaces.map(item => <button key={item.id} className={surface === item.id ? 'selected' : ''} aria-current={surface === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><item.icon size={26} /><span>{item.label}</span></button>)}</nav>
      <div className="sidebar-session">{snapshot?.session.voiceChannel && <><span>Listening room</span><strong><UsersIcon size={17} />{snapshot.session.voiceChannel.name}</strong>{snapshot.session.listeners.length > 0 && <div className="listeners"><div>{snapshot.session.listeners.slice(0, 5).map(listener => <Avatar key={listener.id} url={listener.avatarUrl} name={listener.displayName} />)}</div><span>{snapshot.session.listeners.length} listening</span></div>}</>}</div>
      <div className="account"><ActionPopover label="Account options" className="account-popover" panelClassName="account-menu" triggerClassName="account-identity" trigger={<><Avatar url={viewer.avatarUrl} name={viewer.displayName} /><span><strong>{viewer.displayName}</strong><small>{viewer.maintainer ? 'Maintainer' : snapshot?.session.canAdd ? 'In voice' : 'Signed in'}</small></span></>}>{close => <><p>{viewer.displayName}</p><button onClick={() => { close(); navigate('server'); }}>Settings & appearance</button><button onClick={() => { close(); void portal.logout(); }}>Sign out on this device</button></>}</ActionPopover><IconButton label="Open settings" onClick={() => navigate('server')}><GearSixIcon size={23} weight="fill" /></IconButton></div>
    </aside>
    <div className="portal-main"><header className={`topbar ${expanded ? 'sleeve-topbar' : ''}`}><div className="page-title"><h1 hidden={expanded}>{heading}</h1><p>{subtitle}</p></div><div className="topbar-actions"><button type="button" className="header-search" aria-label="Search music" disabled={noGuilds} onClick={openSearch}><MagnifyingGlassIcon size={21} /><span>{query || 'Search songs, artists, or paste a link...'}</span></button><button className="button primary" disabled={noGuilds} onClick={openSearch}><PlusIcon size={23} /><span>Add music</span></button></div></header>
      {!noGuilds && connection !== 'live' && <div className={`connection-banner ${connection === 'offline' ? 'offline' : ''}`} role="status">{connection === 'offline' ? <WifiSlashIcon size={21} /> : <span className="spinner" />}<div><strong>{connection === 'offline' ? 'Live updates paused' : 'Getting fresh state'}</strong><span>{connection === 'offline' ? portal.connectionError || 'Reconnect before making changes. Discord playback continues.' : 'Controls return once the current session is verified.'}</span></div>{connection === 'offline' && <button className="text-button" onClick={portal.reconnect}><ArrowClockwiseIcon size={18} />Reconnect</button>}</div>}
      <main id="main-content" tabIndex={-1} className={expanded ? 'main-surface expanded-main' : 'main-surface page-content'}>{expanded && <h1 className="sr-only">Now playing</h1>}<div hidden={expanded}>{noGuilds ? <Empty title="No listening spaces available" description="Sign in with an account that belongs to a server where Vybertron is installed. The portal does not offer public bot installation." action={<button className="button secondary" onClick={() => void portal.loadBootstrap()}><ArrowClockwiseIcon size={18} />Refresh access</button>} /> : !snapshot ? connection === 'offline' ? <ErrorState message={portal.connectionError} retry={portal.reconnect} /> : <Loading /> : <>
        {surface === 'session' && !expanded && <><Recovery portal={portal} />{snapshot.session.reason && <div className="permission-note"><WarningCircleIcon size={20} /><span>{snapshot.session.reason}</span></div>}<Queue portal={portal} onAdd={openSearch} /></>}
        <LibraryView portal={portal} active={surface === 'music' && !expanded} />
        <ServerView portal={portal} active={surface === 'server' && !expanded} ambient={ambient} setAmbient={setAmbient} installPrompt={installPrompt} install={install} />
      </>}</div>{!noGuilds && <Player portal={portal} expanded={expanded} setExpanded={setExpanded} onAdd={openSearch} accent={palette.accent} animate={ambient !== 'off' && !reduced && !hidden} />}</main>
    </div>
    <Search portal={portal} open={searchOpen} onClose={() => setSearchOpen(false)} query={query} setQuery={setQuery} />
    {portal.notice && !searchOpen && <div className={`toast ${portal.notice.kind}`} role={portal.notice.kind === 'error' ? 'alert' : 'status'}><span>{portal.notice.message}</span><IconButton label="Dismiss notification" onClick={portal.dismissNotice}><XIcon size={19} /></IconButton></div>}
    {update && <div className="update-notice"><span>A fresh version of Vybertron is ready.</span><button className="text-button" onClick={() => { navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true }); update.postMessage({ type: 'ACTIVATE' }); }}>Update app</button></div>}
  </div>;
}
function Brand() { return <div className="brand"><WaveformIcon size={30} weight="bold" aria-hidden="true" /><span>Vybertron</span></div>; }
