import { useEffect, useRef, useState } from 'react';
import { ArrowClockwiseIcon, ArrowRightIcon, CaretDownIcon, DiscordLogoIcon, GearSixIcon, HeartIcon, HouseIcon, MagnifyingGlassIcon, MusicNotesIcon, PlusIcon, UsersIcon, WarningCircleIcon, WaveformIcon, WifiSlashIcon, XIcon } from '@phosphor-icons/react';
import type { Surface } from './types';
import { usePortal } from './usePortal';
import { useListening } from './playback';
import { publicUrl } from './api';
import { useArtPalette } from './art';
import { Spectrum } from './components/Spectrum';
import { RoomLight } from './components/RoomLight';
import { FpsMeter, SceneCanvas, fpsChosen, glSceneChosen } from './components/SceneCanvas';
import { statusLabel } from './format';
import { ActionPopover, Avatar, Empty, ErrorState, FallbackCover, IconButton, Loading } from './components/ui';
import { Player } from './components/Player';
import { Queue } from './components/Queue';
import { Search } from './components/Search';
import { LibraryView } from './components/Library';
import { Home } from './components/Home';
import { ServerView, type AmbientMode, type InstallPrompt } from './components/Server';
import { Recovery } from './components/Recovery';
import { ShareDialog } from './components/Share';
import { holdForSignIn, initialShare } from './share';
import { transition } from './motion';
import { longPress } from './longPress';
import { applyPerformance, applySkin, initialPerformance, initialSkin, loadLook, skinLook, type Skin } from './skin';

function initialAmbient(): AmbientMode {
  try { const value = localStorage.getItem('vybertron.ambient'); return value === 'off' || value === 'subtle' || value === 'on' ? value : 'on'; } catch { return 'on'; }
}
const surfaces: { id: Surface; label: string; icon: typeof MusicNotesIcon }[] = [
  { id: 'home', label: 'Home', icon: HouseIcon }, { id: 'session', label: 'Session', icon: MusicNotesIcon }, { id: 'music', label: 'My Music', icon: HeartIcon }, { id: 'server', label: 'Server', icon: UsersIcon },
];

export function App() {
  const portal = useListening(usePortal());
  const [surface, setSurface] = useState<Surface>('home');
  const [expanded, setExpanded] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [ambient, changeAmbient] = useState<AmbientMode>(initialAmbient);
  const [skin, changeSkin] = useState<Skin>(initialSkin);
  const [performance, changePerformance] = useState(initialPerformance);
  const [glScene, setGlScene] = useState(glSceneChosen);
  const [fps] = useState(fpsChosen);
  const [hidden, setHidden] = useState(document.hidden);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [update, setUpdate] = useState<ServiceWorker | null>(null);
  const [shared, setShared] = useState(initialShare);
  const navigationState = useRef({ surface, expanded });
  const { bootstrap, snapshot, connection, auth } = portal;
  useEffect(() => {
    const change = () => setHidden(document.hidden); const media = matchMedia('(prefers-reduced-motion: reduce)'); const motionChange = () => setReduced(media.matches);
    document.addEventListener('visibilitychange', change); media.addEventListener('change', motionChange);
    const install = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt); };
    const installed = () => { setInstallPrompt(null); portal.notify('Vybatron is ready on your home screen.', 'success'); };
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
  useEffect(() => longPress(), []);
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
  // Look and lighting changes crossfade the whole page instead of repainting it in one frame.
  const setAmbient = (value: AmbientMode) => transition('theme', () => { changeAmbient(value); try { localStorage.setItem('vybertron.ambient', value); } catch { /* Optional, non-sensitive preference. */ } });
  // A look's chunk loads before it applies, so the switch stays one atomic crossfade. The
  // latest choice wins if an earlier one is still loading. The browser won't refetch a script
  // chunk that failed, so a failed look asks for a reload; the current look stays meanwhile.
  const skinChoice = useRef(0);
  const setSkin = (value: Skin) => {
    const choice = ++skinChoice.current;
    loadLook(value).then(() => {
      if (choice === skinChoice.current) transition('theme', () => { applySkin(value); changeSkin(value); });
    }, () => { if (choice === skinChoice.current) portal.notify('That look couldn’t load. Check your connection, then reload the page and try again.', 'error'); });
  };
  const setPerformance = (value: boolean) => transition('theme', () => { applyPerformance(value); changePerformance(value); });
  const order = (value: Surface) => surfaces.findIndex(item => item.id === value);
  // Leaving the sleeve folds the cover back into the deck; otherwise the view slides along the nav.
  const navigate = (value: Surface) => {
    if (value === surface && !expanded) return;
    transition(expanded ? 'collapse' : 'view', () => { setSurface(value); setExpanded(false); }, order(value) < order(surface) ? 'back' : 'forward');
  };
  // A swipe hands over `settle` so the transition starts from wherever the finger left the player.
  const toggleExpanded = (value: boolean, settle?: () => void) => { if (value === expanded) { settle?.(); return; } transition(value ? 'expand' : 'collapse', () => { settle?.(); setExpanded(value); }); };
  const openSearch = () => setSearchOpen(true);
  // Search stays open-able for drafts and browsing; a real permission block (not a stale read) demotes the call to action.
  const addBlocked = connection === 'live' && !!snapshot && !snapshot.session.canAdd;
  const install = () => { if (installPrompt) void installPrompt.prompt().then(() => installPrompt.userChoice).then(() => setInstallPrompt(null)).catch(() => portal.notify('Use your browser’s Install app option to try again.')); };
  // Ambient motion: off by choice, reduced motion, a hidden tab, or performance mode stills it.
  const still = ambient === 'off' || reduced || hidden || performance;
  const motion = !still && connection === 'live' && snapshot?.session.status === 'playing';
  const artwork = publicUrl(snapshot?.session.current?.artworkUrl);
  const palette = useArtPalette(artwork);
  // Commit inherited tokens once. The large scenery dissolves between fixed palettes in RoomLight;
  // controls retain their native color transitions without repeatedly restyling the whole page.
  useEffect(() => {
    palette.glow.forEach((color, index) => document.documentElement.style.setProperty(`--glow-${index + 1}`, color));
    document.documentElement.style.setProperty('--accent', palette.accent);
    document.documentElement.style.setProperty('--ground', palette.ground);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.ground);
  }, [palette]);
  const Look = skinLook(skin);
  // The room draws in one WebGL canvas; the DOM scenery below stays as its layout source.
  const gl = glScene;
  const scene = (moving: boolean) => <div className={`ambient-scene ${gl ? 'gl-scene' : ''} ${expanded ? 'immersive' : ''} ${moving ? 'moving' : 'settled'} ${ambient === 'subtle' ? 'subtle' : ''} ${ambient === 'off' ? 'disabled' : ''}`} aria-hidden="true">
    {gl && <SceneCanvas onFail={() => setGlScene(false)} />}
    <RoomLight palette={palette} instant={hidden} quick={reduced}>{prepared => <>
    <ArtworkField url={artwork} />
    {Look && <Look.Scenery prepared={prepared} />}
    </>}</RoomLight>
  </div>;
  const background = <>{scene(motion)}{fps && <FpsMeter />}</>;
  // Sign-in has no session to wait for; the horizon idles there whenever ambient motion is allowed.
  const welcome = <>{scene(!still)}{fps && <FpsMeter />}</>;
  if (auth === 'loading') return <div className="auth-page">{welcome}<Brand /><Loading label="Finding your listening space…" /></div>;
  if (auth === 'signed-out' || auth === 'error') return <div className="auth-page">{welcome}<Brand /><main className="sign-in"><h1 className="sr-only">Sign in to Vybatron</h1><div className="signin-sleeve"><FallbackCover /></div><Spectrum className="signin-spectrum" seed="vybertron" color={palette.accent} mode="playing" animate={!still} bands={36} /><p>{shared?.link ? 'Sign in with Discord to add the link you shared.' : 'Sign in with Discord to pick songs and control the music in your server.'}</p>{auth === 'error' ? <ErrorState message={portal.authError} retry={() => void portal.loadBootstrap()} /> : <a className="button primary discord-signin" href="/auth/discord" onClick={() => holdForSignIn(shared)}><DiscordLogoIcon size={25} weight="fill" />Continue with Discord<ArrowRightIcon size={20} /></a>}<span className="signin-footnote">Plays in your Discord voice channel, or right here when you’re not in one.</span></main></div>;
  const viewer = bootstrap!.viewer;
  const noGuilds = !bootstrap!.guilds.length;
  const inviteUrl = bootstrap!.inviteUrl;
  const heading = surface === 'home' ? 'Home' : surface === 'session' ? portal.target === 'local' ? 'Your Queue' : 'Shared Queue' : surface === 'music' ? 'My Music' : 'Your Server';
  const room = snapshot?.session.voiceChannel; const listening = snapshot?.session.listeners.length || 0;
  // Voice room and listeners live once, in the server header; tabs name each page's sections.
  const place = portal.target === 'local' ? 'On this device' : room ? room.name : snapshot?.savedSession.voiceChannel ? `Saved in ${snapshot.savedSession.voiceChannel.name}` : 'Join a voice channel';
  return <div className={`app-shell ${expanded ? 'player-open' : ''} ${motion ? 'motion-live' : ''} ${connection !== 'live' ? 'has-connection-notice' : ''}`}>{background}<a href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to content</a>
    <aside className="sidebar" data-glass><Brand /><div className="guild-card"><div className="guild-icon">{snapshot?.guild.iconUrl || bootstrap!.guilds.find(g => g.id === portal.guildId)?.iconUrl ? <img src={publicUrl(snapshot?.guild.iconUrl || bootstrap!.guilds.find(g => g.id === portal.guildId)?.iconUrl)} alt="" /> : <DiscordLogoIcon size={26} weight="fill" />}</div><div className="guild-info"><label className="sr-only" htmlFor="guild">Server</label><select id="guild" aria-label="Server" value={portal.guildId} disabled={noGuilds} onChange={event => { portal.selectGuild(event.target.value); setExpanded(false); }}><option value="" disabled>Select server</option>{bootstrap!.guilds.map(guild => <option key={guild.id} value={guild.id}>{guild.name}</option>)}</select><span className={`guild-status ${snapshot?.session.status || 'idle'}`}><span className="status-dot" /><span className="guild-status-text">{statusLabel(snapshot)} · {place}{listening > 0 && <span className="guild-listeners"> · {listening} listening</span>}</span></span></div><CaretDownIcon className="guild-caret" size={16} /></div>
      <nav className="navigation" aria-label="Main navigation">{surfaces.map(item => <button key={item.id} className={surface === item.id ? 'selected' : ''} aria-current={surface === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>{surface === item.id && <span className="nav-indicator" aria-hidden="true" />}<item.icon size={26} /><span>{item.label}</span></button>)}</nav>
      <div className="sidebar-session">{snapshot?.session.voiceChannel && snapshot.session.listeners.length > 0 && <div className="listeners"><div>{snapshot.session.listeners.slice(0, 5).map(listener => <Avatar key={listener.id} url={listener.avatarUrl} name={listener.displayName} />)}</div><span>{snapshot.session.listeners.length} listening</span></div>}</div>
      <IconButton className={`mobile-add ${addBlocked ? 'blocked' : ''}`} label="Add music" title={addBlocked ? portal.blockedReason : 'Add music'} disabled={noGuilds} onClick={openSearch}><PlusIcon size={24} weight="bold" /></IconButton>
      <div className="account"><ActionPopover label="Account options" className="account-popover" panelClassName="account-menu" triggerClassName="account-identity" trigger={<><Avatar url={viewer.avatarUrl} name={viewer.displayName} /><span><strong>{viewer.displayName}</strong><small>{viewer.maintainer ? 'Maintainer' : portal.target === 'local' ? 'Listening here' : snapshot?.session.canAdd ? 'In voice' : 'Signed in'}</small></span></>}>{close => <><p>{viewer.displayName}</p><button onClick={() => { close(); navigate('server'); }}>Settings & appearance</button>{inviteUrl && <a href={inviteUrl} target="_blank" rel="noopener noreferrer" onClick={close}>Add Vybatron to a server</a>}<button onClick={() => { close(); void portal.logout(); }}>Sign out on this device</button></>}</ActionPopover><IconButton label="Open settings" onClick={() => navigate('server')}><GearSixIcon size={23} weight="fill" /></IconButton></div>
    </aside>
    <div className="portal-main"><header className={`topbar ${expanded ? 'sleeve-topbar' : ''}`}><div className="page-title"><h1 hidden={expanded}>{heading}</h1></div><div className="topbar-actions"><button type="button" className="header-search" aria-label="Search music" disabled={noGuilds} onClick={openSearch}><MagnifyingGlassIcon size={21} /><span>{query || 'Search songs, artists, or paste a link...'}</span></button><button className={`button ${addBlocked ? 'secondary' : 'primary'}`} title={addBlocked ? portal.blockedReason : undefined} disabled={noGuilds} onClick={openSearch}><PlusIcon size={23} /><span>Add music</span></button></div></header>
      {!noGuilds && connection !== 'live' && <div className={`connection-banner ${connection === 'offline' ? 'offline' : ''}`} role="status">{connection === 'offline' ? <WifiSlashIcon size={21} /> : <span className="spinner" />}<div><strong>{connection === 'offline' ? 'Live updates paused' : 'Getting fresh state'}</strong><span>{connection === 'offline' ? portal.connectionError || 'Reconnect before making changes. Discord playback continues.' : 'Controls return once the current session is verified.'}</span></div>{connection === 'offline' && <button className="text-button" onClick={portal.reconnect}><ArrowClockwiseIcon size={18} />Reconnect</button>}</div>}
      <main id="main-content" tabIndex={-1} className={expanded ? 'main-surface expanded-main' : 'main-surface page-content'}>{expanded && <h1 className="sr-only">Now playing</h1>}<div className="surface-stage" hidden={expanded}>{noGuilds ? <Empty title="No listening spaces available" description={inviteUrl ? 'Vybatron isn’t in any of your servers yet. Add it to a server you manage, then refresh.' : 'Sign in with an account that belongs to a server where Vybatron is installed. Vybatron is private, so ask its owner to add it to yours.'} action={<div className="empty-actions">{inviteUrl && <a className="button primary" href={inviteUrl} target="_blank" rel="noopener noreferrer"><DiscordLogoIcon size={18} weight="fill" />Add to a server</a>}<button className="button secondary" onClick={() => void portal.loadBootstrap()}><ArrowClockwiseIcon size={18} />Refresh access</button></div>} /> : !snapshot ? connection === 'offline' ? <ErrorState message={portal.connectionError} retry={portal.reconnect} /> : <Loading /> : <>
        {surface === 'session' && <><Recovery portal={portal} />{snapshot.session.reason && <div className="permission-note"><WarningCircleIcon size={20} /><span>{snapshot.session.reason}</span></div>}<Queue portal={portal} onAdd={openSearch} /></>}
        {/* The sleeve hides the selected page without rebuilding its shelves when it closes. */}
        <Home portal={portal} active={surface === 'home'} onOpenPlayer={() => toggleExpanded(true)} />
        <LibraryView portal={portal} active={surface === 'music'} />
        <ServerView portal={portal} active={surface === 'server'} ambient={ambient} setAmbient={setAmbient} skin={skin} setSkin={setSkin} performance={performance} setPerformance={setPerformance} installPrompt={installPrompt} install={install} />
      </>}</div>{!noGuilds && <Player portal={portal} expanded={expanded} setExpanded={toggleExpanded} onAdd={openSearch} accent={palette.accent} animate={!still} skin={skin} />}</main>
    </div>
    {shared && <ShareDialog portal={portal} link={shared.link} onClose={() => setShared(null)} />}
    <Search portal={portal} open={searchOpen} onClose={() => setSearchOpen(false)} query={query} setQuery={setQuery} />
    {portal.notice && !searchOpen && !shared && <div className={`toast ${portal.notice.kind}`} role={portal.notice.kind === 'error' ? 'alert' : 'status'}><span>{portal.notice.message}</span><IconButton label="Dismiss notification" onClick={portal.dismissNotice}><XIcon size={19} /></IconButton></div>}
    {update && <div className="update-notice"><span>A fresh version of Vybatron is ready.</span><button className="text-button" onClick={() => { navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true }); update.postMessage({ type: 'ACTIVATE' }); }}>Update app</button></div>}
  </div>;
}
// The blurred cover behind the room crossfades between songs: the next layer joins only once it has
// decoded, and the previous one fades out beneath it, so the room never blinks empty or snaps.
function ArtworkField({ url }: { url?: string }) {
  const [layers, setLayers] = useState<string[]>(() => url ? [url] : []);
  const [shown, setShown] = useState(url);
  useEffect(() => {
    if (!url) { setShown(undefined); return; }
    let current = true; const image = new Image(); image.referrerPolicy = 'no-referrer'; image.src = url;
    void image.decode().then(() => {
      if (!current) return;
      setLayers(layers => layers.includes(url) ? layers : [...layers.slice(-1), url]);
      setShown(url);
    }, () => { if (current) setShown(undefined); });
    return () => { current = false; };
  }, [url]);
  // Drop faded layers once their fade has finished.
  useEffect(() => {
    const timer = setTimeout(() => setLayers(current => current.filter(layer => layer === shown)), 1200);
    return () => clearTimeout(timer);
  }, [shown]);
  return <>{layers.map(layer => <img key={layer} className={`artwork-field ${layer === shown ? 'shown' : ''}`} src={layer} alt="" referrerPolicy="no-referrer" />)}</>;
}
function Brand() { return <div className="brand"><WaveformIcon size={30} weight="bold" aria-hidden="true" /><span>Vybatron<span className="brand-glint" data-text="Vybatron" aria-hidden="true" /></span></div>; }
