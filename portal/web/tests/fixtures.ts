// Explicit loopback browser-test fixtures. Not imported by src or emitted in production.
import type { Locator, Page } from '@playwright/test';
import type { Activity, Bootstrap, Command, Configuration, Diagnostics, GuildSnapshot, Library, Track, Recap, Stats } from '../src/types';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const art = (name: string) => `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_PORT || 4178)}/test-art/${name}.png`;
const person = (id: string, displayName: string, image: string) => ({ id, displayName, avatarUrl: art(image) });
const people = [person('jordan', 'Jordan', 'jordan'), person('alex', 'Alex', 'alex'), person('sam', 'Sam', 'sam')];
const vybertron = { id: 'vybertron', displayName: 'Vybatron', avatarUrl: null };
export function suggestedTracks(): Track[] {
  return [suggestion('city-lights', 'City Lights', 'Northline', 221_000, 'golden'), suggestion('low-tide', 'Low Tide', 'Solara', 198_000, 'afterglow')];
}
function suggestion(id: string, title: string, author: string, durationMs: number, artwork: string): Track {
  return { ...track(id, title, author, durationMs, artwork), requestedBy: vybertron, suggested: true };
}
function track(id: string, title: string, author: string, durationMs: number, artwork: string, requester = 0): Track {
  return { id: createHash('sha256').update(id).digest('hex').slice(0, 24), title, author, durationMs, artworkUrl: art(artwork), uri: `https://example.com/music/${id}`, source: 'SoundCloud', isStream: false, requestedBy: people[requester] };
}
export function fixtureState() {
  const current = track('evening-light', 'Evening Light', 'Glass Avenue', 237_000, 'evening');
  const tracks = [track('night-drive', 'Night Drive', 'Solara', 252_000, 'night'), track('slow-motion', 'Slow Motion', 'Glass Avenue', 214_000, 'slow', 1), track('golden-hour', 'Golden Hour', 'Northline', 238_000, 'golden', 2), track('afterglow', 'Afterglow', 'Solara', 246_000, 'afterglow')];
  const snapshot: GuildSnapshot = {
    guild: { id: 'testing', name: 'Bot Testing', iconUrl: null, admin: true }, revision: 'revision-1',
    session: { status: 'playing', voiceChannel: { id: 'voice', name: 'General' }, textChannel: { id: 'text', name: 'General' }, current, queue: tracks, suggestions: [], positionMs: 107_000, durationMs: 237_000, volume: 75, filter: 'warm', repeat: 'off', radio: false, autoplay: 'off', fairQueue: false, listeners: people, canAdd: true, canControl: true, canVote: true, reason: null },
    savedSession: { exists: false, savedAt: null, positionMs: 0, paused: false, trackCount: 0, voiceChannel: null, canResume: false },
    settings: { volume: 100, fairQueue: false, autoplay: 'off', djRoleId: null, musicTextChannelId: 'text' }, channels: [{ id: 'voice', name: 'General', type: 'voice' }, { id: 'text', name: 'General', type: 'text' }], roles: [{ id: 'dj', name: 'DJs' }],
  };
  const configuration: Configuration = { guildId: snapshot.guild.id, channels: [...structuredClone(snapshot.channels), { id: 'lounge', name: 'music-lounge', type: 'text' }], roles: structuredClone(snapshot.roles) };
  const bootstrap: Bootstrap = { viewer: { id: 'alex', username: 'alex', displayName: 'Alex', avatarUrl: art('alex'), maintainer: false }, guilds: [snapshot.guild], csrfToken: 'local-test-csrf', inviteUrl: INVITE_URL, filters: [{ id: 'off', label: 'Original', description: 'Unfiltered playback' }, { id: 'warm', label: 'Warm', description: 'A softer, warm sound' }], commands: [
    { name: 'play', description: 'Add a song or public playlist', options: [{ name: 'query', type: 3, required: true, max_length: 200 }] },
    { name: 'playnext', description: 'Play a song next', options: [{ name: 'query', type: 3, required: true, max_length: 200 }] },
    { name: 'replay', description: 'Replay a visible history entry', options: [{ name: 'index', type: 4, required: true, min_value: 1, max_value: 100 }] },
    { name: 'clear', description: 'Clear the upcoming queue' },
    { name: 'favorite', options: [{ name: 'add', type: 1, options: [{ name: 'position', type: 4, min_value: 1, max_value: 500 }] }, { name: 'clear', type: 1, options: [{ name: 'confirm', type: 5, required: true }] }, ...['play', 'remove'].map(name => ({ name, type: 1, options: [{ name: 'index', type: 4, required: true, min_value: 1, max_value: 1000 }] }))] },
    { name: 'mix', options: [{ name: 'save', type: 1, options: [{ name: 'name', type: 3, required: true, max_length: 40 }, { name: 'replace', type: 5 }] }, { name: 'delete', type: 1, options: [{ name: 'name', type: 3, required: true, max_length: 40 }] }] },
    { name: 'seek', description: 'Jump to a timestamp', options: [{ name: 'timestamp', description: 'mm:ss or hh:mm:ss', type: 3, required: true, min_length: 4, max_length: 12 }] },
    { name: 'radio', description: 'Keep the music going', options: [{ name: 'on', type: 1, options: [{ name: 'track', type: 3, max_length: 200 }] }, { name: 'off', type: 1 }, ...['promote', 'remove', 'less'].map(name => ({ name, type: 1, options: [{ name: 'position', type: 4, required: name !== 'less', min_value: 1, max_value: 3 }] }))] },
    { name: 'settings', description: 'Set server listening defaults', options: [{ name: 'volume', type: 1, options: [{ name: 'value', type: 4, required: true, min_value: 0, max_value: 100 }] }, { name: 'musicchannel', type: 1, options: [{ name: 'channel', type: 7, required: true }] }, { name: 'djrole', type: 1, options: [{ name: 'role', type: 8 }] }] },
    { name: 'session', options: [{ name: 'resume', type: 1 }, { name: 'discard', type: 1 }] },
  ] };
  const library: Library = { favorites: [tracks[0], current], mixes: [{ id: 'night-shift', name: 'Night shift', ownerId: 'alex', version: 'a'.repeat(32), canEdit: true, tracks: [current, ...tracks] }], history: [{ id: 'history-1', playedAt: 1_791_147_600_000, voiceChannel: { id: 'voice', name: 'General' }, track: tracks[3] }] };
  const diagnostics: Diagnostics = { botReady: true, audioReady: true, uptimeSeconds: 28_800, recoveryState: 'Healthy', lastError: null };
  const activity: Activity = { items: [{ id: 'activity-1', at: 1_791_147_600_000, actor: { id: 'jordan', displayName: 'Jordan' }, action: 'Added a song', detail: 'Night Drive joined the shared queue.' }] };
  const stats: Stats = { serverFavorites: {
    onRepeat: tracks.slice(0, 4).map((item, index) => ({ track: item, plays: 9 - index * 2, lastPlayedAt: 1_791_147_600_000 - index * 86_400_000 })),
    forgottenGems: [{ track: current, plays: 6, lastPlayedAt: 1_784_000_000_000 }] },
    personal: { window: '30d', topTracks: [], topArtists: [], rediscover: [{ index: 1, track: tracks[0], requests: 3, lastRequestedAt: 1_784_000_000_000 }], playlists: [
      { id: 'your-mix', kind: 'mix', title: 'Your mix', artist: null, refreshesAt: 1_791_590_400_000, tracks: [tracks[2], current, tracks[0], tracks[3], tracks[1]] },
      { id: 'top-tracks', kind: 'top', title: 'Your top tracks', artist: null, refreshesAt: null, tracks: [current, tracks[1]] },
      { id: 'rediscover', kind: 'rediscover', title: 'Rediscover', artist: null, refreshesAt: null, tracks: [tracks[0]] },
      { id: 'artist-1', kind: 'artist', title: 'Solara mix', artist: 'Solara', refreshesAt: null, tracks: [tracks[0], tracks[3]] },
    ] } };
  const recap: Recap = { window: '30d', since: 1_788_555_600_000,
    personal: { plays: 23, playedMs: 4_380_000, songs: 9,
      topTracks: [{ track: current, plays: 7, lastPlayedAt: 1_791_147_600_000 }, { track: tracks[1], plays: 4, lastPlayedAt: 1_791_000_000_000 }],
      topArtists: [{ name: 'Glass Avenue', plays: 9, lastPlayedAt: 1_791_147_600_000, track: current }, { name: tracks[2].author, plays: 4, lastPlayedAt: 1_791_000_000_000, track: tracks[2] }] },
    server: { plays: 184, playedMs: 33_120_000, songs: 61,
      topTracks: tracks.slice(0, 4).map((item, index) => ({ track: item, plays: 18 - index * 3, lastPlayedAt: 1_791_147_600_000 - index * 86_400_000 })) } };
  return { snapshot, configuration, bootstrap, library, diagnostics, activity, stats, recap };
}
// Model the selected-item HTTP contract independently of the browser's capture logic.
export function selectedCommandError(library: Library, command: Command) {
  const token = command.command === 'favorite' && ['play', 'remove'].includes(command.subcommand || '') ? command.expectedTrackId
    : command.command === 'replay' ? command.expectedHistoryId
    : command.command === 'mix' && command.subcommand === 'delete' ? command.expectedMixVersion : null;
  if (token === null) return null;
  const shape = command.command === 'favorite' ? /^[a-f0-9]{24}$/ : command.command === 'mix' ? /^[a-f0-9]{32}$/ : /^[^\u0000-\u001f\u007f]{1,40}$/;
  if (!token || !shape.test(token)) return { status: 400, code: 'invalid_selection', message: 'Include the selected library item token.' };
  const expected = command.command === 'favorite' ? library.favorites[Number(command.options?.index) - 1]?.id
    : command.command === 'replay' ? library.history[Number(command.options?.index) - 1]?.id
    : library.mixes.find(mix => mix.name.toLowerCase() === String(command.options?.name).trim().toLowerCase().replace(/\s+/g, ' '))?.version;
  if (expected !== token) return { status: 409, code: 'stale_selection', message: 'The selected library item changed.' };
  return null;
}
export const INVITE_URL = 'https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot+applications.commands&permissions=281474979875840&integration_type=0';
export async function mockPortal(page: Page, options: { signedOut?: boolean; basic?: boolean; outsideVoice?: boolean; saved?: boolean; maintainerOutsideGuild?: boolean; suggested?: boolean } = {}) {
  const state = fixtureState();
  if (options.suggested) Object.assign(state.snapshot.session, { radio: true, autoplay: 'on', queue: state.snapshot.session.queue.slice(0, 1), suggestions: suggestedTracks() });
  if (options.basic) { state.snapshot.guild.admin = false; state.snapshot.settings = null; state.snapshot.roles = []; state.snapshot.channels = []; state.snapshot.session.canControl = false; state.snapshot.session.reason = 'Playback controls need the DJ role. You can add music and vote to skip.'; }
  if (options.outsideVoice) { state.snapshot.session.canAdd = false; state.snapshot.session.canControl = false; state.snapshot.session.canVote = false; state.snapshot.session.reason = 'Join General to add music or use playback controls.'; }
  if (options.maintainerOutsideGuild) {
    state.bootstrap.viewer.maintainer = true; state.snapshot.channels = []; state.snapshot.roles = [];
    state.configuration.channels = []; state.configuration.roles = [];
    state.snapshot.settings = { volume: 100, fairQueue: false, autoplay: 'off', musicTextChannelId: '123456789012345678', djRoleId: '223456789012345678' };
    Object.assign(state.snapshot.session, { status: 'idle', current: null, queue: [], listeners: [], voiceChannel: null, textChannel: null, canAdd: false, canControl: false, canVote: false, reason: 'Join this server to control playback.' });
  }
  if (options.saved) { state.snapshot.session.status = 'idle'; state.snapshot.session.current = null; state.snapshot.session.queue = []; state.snapshot.savedSession = { exists: true, savedAt: 1_791_147_600_000, positionMs: 107_000, paused: true, trackCount: 5, voiceChannel: { id: 'voice', name: 'General' }, canResume: true }; }
  const commands: Command[] = []; const requests: string[] = []; const requestClears: string[] = []; const recapWindows: string[] = [];
  const logouts: { method: string; body: string | null; contentType: string | null; csrfToken: string | null }[] = [];
  let signedOut = !!options.signedOut;
  let conflict = false; let snapshotDelay = 0; let libraryFailure = false; let snapshotFailure = 0;
  let uncertain = false; let commandDelay = 0; let commandGate: Promise<void> | undefined; let libraryDelay = 0;
  await page.addInitScript(() => {
    const streams: FakeEventSource[] = [];
    class FakeEventSource {
      onopen: (() => void) | null = null; onerror: (() => void) | null = null; closed = false;
      listeners = new Map<string, ((event: MessageEvent) => void)[]>();
      constructor() { streams.push(this); setTimeout(() => { if (!this.closed) this.onopen?.(); }, 20); }
      addEventListener(type: string, callback: (event: MessageEvent) => void) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]); }
      close() { this.closed = true; }
    }
    Object.defineProperty(window, 'EventSource', { value: FakeEventSource });
    (window as unknown as { portalTest: { emit: (data: unknown) => void; disconnect: () => void; reconnect: () => void } }).portalTest = {
      emit: data => streams.filter(s => !s.closed).forEach(s => s.listeners.get('snapshot')?.forEach(callback => callback(new MessageEvent('snapshot', { data: JSON.stringify(data) })))),
      disconnect: () => streams.filter(s => !s.closed).forEach(s => s.onerror?.()), reconnect: () => window.dispatchEvent(new Event('online')),
    };
  });
  await page.route('**/test-art/*.png', async route => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    await route.fulfill({ path: fileURLToPath(new URL(`./art/${name}`, import.meta.url)), contentType: 'image/png' });
  });
  const reply = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname; requests.push(path);
    if (signedOut) { await route.fulfill({ status: 401, json: { error: { code: 'unauthenticated', message: 'Sign in with Discord.' } } }); return; }
    if (path.endsWith('/bootstrap')) await route.fulfill(reply(state.bootstrap));
    else if (path.endsWith('/configuration')) {
      if (!state.snapshot.guild.admin) await route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Manage Server permission is required for channel and role options.' } } });
      else await route.fulfill(reply(state.configuration));
    }
    else if (path.endsWith('/library')) { if (libraryFailure) await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'The music library is temporarily unavailable.' } } }); else { const response = reply(state.library); const delay = libraryDelay; if (delay) await new Promise(resolve => setTimeout(resolve, delay)); await route.fulfill(response); } }
    else if (path.endsWith('/search')) await route.fulfill(reply({ tracks: [track('midnight-city', 'Midnight City', 'M83', 244_000, 'night')], notice: 'Local browser-test search results.' }));
    else if (path.endsWith('/diagnostics')) await route.fulfill(reply(state.diagnostics));
    else if (path.endsWith('/activity')) await route.fulfill(reply(state.activity));
    else if (path.endsWith('/stats')) await route.fulfill(reply(state.stats));
    else if (path.endsWith('/recap')) {
      const window = new URL(route.request().url()).searchParams.get('window') || '30d';
      recapWindows.push(window);
      await route.fulfill(reply({ ...state.recap, window }));
    }
    else if (path === '/api/stats/requests/clear') {
      if (route.request().method() !== 'POST' || route.request().headers()['x-csrf-token'] !== 'local-test-csrf') throw new Error('Clearing stats needs a CSRF-checked POST');
      requestClears.push(path);
      const cleared = state.stats.personal.topTracks.length + 4;
      state.recap = { ...state.recap, personal: { plays: 0, playedMs: 0, songs: 0, topTracks: [], topArtists: [] } };
      state.stats.personal = { ...state.stats.personal, topTracks: [], topArtists: [], playlists: state.stats.personal.playlists.filter(list => list.kind !== 'artist').map(list => list.kind === 'rediscover' ? list : { ...list, tracks: [] }) };
      await route.fulfill(reply({ ok: true, cleared }));
    }
    else if (path.endsWith('/commands')) {
      const body = route.request().postDataJSON() as Command; commands.push(body);
      if (route.request().headers()['x-csrf-token'] !== 'local-test-csrf') throw new Error('Missing CSRF token');
      if (['playnext', 'replay'].includes(body.command) && (!state.snapshot.session.canControl || body.expectedRevision !== state.snapshot.revision)) { await route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Fresh same-voice DJ control is required.' } } }); return; }
      const selectionError = selectedCommandError(state.library, body);
      if (selectionError) { await route.fulfill({ status: selectionError.status, json: { error: selectionError } }); return; }
      if (commandDelay) await new Promise(resolve => setTimeout(resolve, commandDelay));
      if (commandGate) await commandGate;
      if (conflict) { conflict = false; state.snapshot.revision = `revision-${commands.length + 1}`; state.snapshot.session.queue.reverse(); await route.fulfill({ status: 409, json: { error: { code: 'stale_revision', message: 'The queue changed.' } } }); return; }
      const s = state.snapshot.session; const o = body.options || {};
      if (body.subcommand === 'import') {
        // Three songs found: one already in favorites, two new.
        const found = [s.queue[0], track('road-song-1', 'Open Road', 'Northline', 201_000, 'golden'), track('road-song-2', 'Mile Marker', 'Solara', 188_000, 'night')];
        const mixTracks = state.library.mixes.find(mix => mix.name.toLowerCase() === String(o.name || '').trim().toLowerCase())?.tracks;
        const existing = body.command === 'favorite' ? state.library.favorites : mixTracks || [];
        const add = found.filter(item => !existing.some(saved => saved.id === item.id));
        if (!body.expectedImportId) {
          const preview = { id: 'b'.repeat(32), target: body.command === 'favorite' ? 'favorites' : 'mix', name: body.command === 'mix' ? String(o.name) : null, title: 'Road trip',
            found: found.length + 1, toAdd: add.length, duplicates: found.length - add.length, unmatched: 1, overLimit: 0, limit: body.command === 'favorite' ? 1000 : 100,
            notes: ['Spotify shows only part of some playlists, so this may not be the whole list.'], tracks: add.map(({ title, author }) => ({ title, author })) };
          await route.fulfill(reply({ ok: true, message: 'Preview ready.', snapshot: state.snapshot, preview })); return;
        }
        if (body.command === 'favorite') state.library.favorites.push(...add);
        else if (mixTracks) mixTracks.push(...add);
        else state.library.mixes.push({ id: `import-${commands.length}`, name: String(o.name), ownerId: 'alex', version: 'c'.repeat(32), canEdit: true, tracks: add });
        await route.fulfill(reply({ ok: true, message: `Added ${add.length} tracks. ${found.length - add.length} track is already saved. 1 track couldn’t be matched to a public recording.`, snapshot: state.snapshot })); return;
      }
      if (body.command === 'pause') s.status = 'paused';
      if (body.command === 'resume') s.status = 'playing';
      if (body.command === 'stop') { s.status = 'idle'; s.current = null; s.queue = []; state.snapshot.savedSession.exists = false; }
      if (body.command === 'clear') s.queue = [];
      if (body.command === 'remove') s.queue.splice(Number(o.position) - 1, 1);
      if (body.command === 'move') { const moved = s.queue.splice(Number(o.from) - 1, 1)[0]; s.queue.splice(Number(o.to) - 1, 0, moved); }
      if (body.command === 'shuffle') s.queue.reverse();
      if (body.command === 'loop') s.repeat = o.mode as typeof s.repeat;
      if (body.command === 'volume') s.volume = Number(o.level);
      if (body.command === 'filter') s.filter = String(o.preset);
      if (body.command === 'radio') {
        const index = Number(o.position || 1) - 1;
        if (['promote', 'remove', 'less'].includes(body.subcommand || '') && body.expectedTrackId !== (o.position ? s.suggestions[index]?.id : s.current?.id)) { await route.fulfill({ status: 409, json: { error: { code: 'suggestion_changed', message: 'The suggestions changed.' } } }); return; }
        if (body.subcommand === 'on' || body.subcommand === 'off') s.radio = body.subcommand === 'on';
        if (body.subcommand === 'promote') s.queue.push(s.suggestions.splice(index, 1)[0]);
        if ((body.subcommand === 'remove' || body.subcommand === 'less') && o.position) s.suggestions.splice(index, 1);
      }
      if (body.command === 'play' || body.command === 'playnext') { const added = track('midnight-city', 'Midnight City', 'M83', 244_000, 'night'); if (body.command === 'playnext') s.queue.unshift(added); else s.queue.push(added); }
      if (body.command === 'favorite') { if (body.subcommand === 'add') { const selected = o.position ? s.queue[Number(o.position) - 1] : s.current; if (selected) state.library.favorites.push(selected); } if (body.subcommand === 'play') s.queue.push(state.library.favorites[Number(o.index) - 1]); if (body.subcommand === 'remove') state.library.favorites.splice(Number(o.index) - 1, 1); if (body.subcommand === 'clear') state.library.favorites = []; }
      if (body.command === 'replay') s.queue.unshift(state.library.history[Number(o.index) - 1].track);
      if (body.command === 'settings' && state.snapshot.settings) { if (body.subcommand === 'volume') state.snapshot.settings.volume = Number(o.value); if (body.subcommand === 'musicchannel') state.snapshot.settings.musicTextChannelId = String(o.channel); if (body.subcommand === 'djrole') state.snapshot.settings.djRoleId = o.role ? String(o.role) : null; if (body.subcommand === 'fairqueue') state.snapshot.settings.fairQueue = !!o.enabled; if (body.subcommand === 'autoplay') { state.snapshot.settings.autoplay = o.mode as 'off'; s.autoplay = o.mode as 'off'; } }
      if (body.command === 'session') { state.snapshot.savedSession.exists = false; if (body.subcommand === 'resume') { s.current = state.library.favorites[1]; s.queue = fixtureState().snapshot.session.queue; s.positionMs = 107_000; s.status = 'paused'; } }
      if (body.command === 'mix') {
        if (body.subcommand === 'save') {
          const key = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');
          const existing = state.library.mixes.find(mix => key(mix.name) === key(String(o.name)));
          const mix = { id: existing?.id || `new-mix-${commands.length}`, name: existing?.name || String(o.name), ownerId: 'alex', version: createHash('md5').update(String(commands.length)).digest('hex'), canEdit: true, tracks: [s.current, ...s.queue].filter((t): t is Track => !!t) };
          if (existing && o.replace) Object.assign(existing, mix);
          else state.library.mixes.push(mix);
        }
        if (body.subcommand === 'delete') state.library.mixes = state.library.mixes.filter(m => m.name !== o.name);
      }
      // A device session moving in: the bot plays the first link where the listener left off.
      if (body.command === 'transfer') Object.assign(s, { status: o.paused ? 'paused' : 'playing', positionMs: Number(o.position), volume: Number(o.volume), repeat: o.repeat,
        current: { ...track('moved-in', 'Moved In', 'M83', 244_000, 'night'), uri: body.tracks![0] }, queue: [], voiceChannel: { id: 'voice', name: 'General' } });
      state.snapshot.revision = `revision-${commands.length + 1}`;
      if (uncertain) { uncertain = false; await route.fulfill({ status: 503, json: { error: { code: 'upstream_timeout', message: 'The bot response did not arrive in time.' } } }); return; }
      await route.fulfill(reply({ ok: true, message: 'Your listening space is updated.', snapshot: state.snapshot }));
    } else {
      if (snapshotDelay) await new Promise(resolve => setTimeout(resolve, snapshotDelay));
      if (snapshotFailure) await route.fulfill({ status: snapshotFailure, json: { error: { code: 'forbidden', message: 'You no longer have access to this listening space.' } } });
      else await route.fulfill(reply(state.snapshot));
    }
  });
  await page.route('**/auth/logout', async route => {
    const request = route.request(); const headers = request.headers();
    const logout = { method: request.method(), body: request.postData(), contentType: headers['content-type'] || null, csrfToken: headers['x-csrf-token'] || null };
    logouts.push(logout);
    if (logout.method !== 'POST' || logout.body !== null || logout.contentType !== null || logout.csrfToken !== 'local-test-csrf') { await route.fulfill({ status: 400, json: { error: { code: 'invalid_logout', message: 'Logout requires a bodyless CSRF-protected POST.' } } }); return; }
    signedOut = true; await route.fulfill({ json: { ok: true } });
  });
  return { state, commands, requests, requestClears, recapWindows, logouts, signIn: () => { signedOut = false; }, conflictNext: () => { conflict = true; }, uncertainNext: () => { uncertain = true; }, delayCommand: (ms: number) => { commandDelay = ms; }, holdCommands: () => { let release!: () => void; commandGate = new Promise(resolve => { release = resolve; }); return () => { commandGate = undefined; release(); }; }, delaySnapshot: (ms: number) => { snapshotDelay = ms; }, delayLibrary: (ms: number) => { libraryDelay = ms; }, failLibrary: () => { libraryFailure = true; }, denySnapshot: (status: number) => { snapshotFailure = status; } };
}

export async function streamAction(page: Page, action: 'disconnect' | 'reconnect', data?: GuildSnapshot) {
  await page.evaluate(({ action, data }) => {
    const test = (window as unknown as { portalTest: { emit: (data: unknown) => void; disconnect: () => void; reconnect: () => void } }).portalTest;
    if (data) test.emit(data); else test[action]();
  }, { action, data });
}
// Opening or closing the player glides the cover and controls into place; measure them once landed.
export async function landed(locator: Locator) {
  await locator.evaluate(element => Promise.all(element.getAnimations({ subtree: true })
    .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity).map(animation => animation.finished)));
}
// Home is the landing view; queue-focused tests start from the Session view.
export async function gotoSession(page: Page, path = '/') {
  await page.goto(path);
  await page.getByRole('button', { name: 'Session', exact: true }).click();
  // Pointer input goes to the document root until the view transition settles.
  await page.waitForFunction(() => !document.documentElement.dataset.motion);
}
