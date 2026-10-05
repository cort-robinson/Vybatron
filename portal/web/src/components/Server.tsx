import { useEffect, useRef, useState } from 'react';
import { ArrowClockwiseIcon, CheckCircleIcon, ClockIcon, DownloadSimpleIcon, GearSixIcon, ShieldCheckIcon, TerminalWindowIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { api, ApiError, errorMessage } from '../api';
import type { Activity, Capability, Command, CommandOption, Configuration, Diagnostics } from '../types';
import type { Portal } from '../usePortal';
import { date, totalTime } from '../format';
import { Confirm, Empty, ErrorState, Loading } from './ui';

export type AmbientMode = 'on' | 'subtle' | 'off';
export interface InstallPrompt extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
const discordIdPattern = '[0-9]{1,20}';
const isDiscordId = (value: string) => /^[0-9]{1,20}$/.test(value);

export function ServerView({ portal, ambient, setAmbient, installPrompt, install }: { portal: Portal; ambient: AmbientMode; setAmbient: (value: AmbientMode) => void; installPrompt: InstallPrompt | null; install: () => void }) {
  const [tab, setTab] = useState<'settings' | 'activity' | 'diagnostics' | 'commands'>('settings');
  const [reset, setReset] = useState(false);
  const { pending, can, run } = portal;
  const snapshot = portal.snapshot?.guild.id === portal.guildId ? portal.snapshot : null;
  const admin = snapshot?.guild.admin === true;
  const view = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    // App keeps its sections mounted. Discovery follows an actual Settings visit.
    const element = view.current; if (!element) return;
    const update = () => setVisible(!element.closest('[hidden]'));
    const observer = new MutationObserver(update);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) observer.observe(parent, { attributes: true, attributeFilter: ['hidden'] });
    update(); return () => observer.disconnect();
  }, []);
  const configuration = useConfiguration(portal.guildId, visible && tab === 'settings' && admin);
  const settings = snapshot?.settings;
  const [volume, setVolume] = useState('100');
  const [channel, setChannel] = useState('');
  const [role, setRole] = useState('');
  const dirty = useRef({ volume: false, channel: false, role: false });
  const settingsGuild = useRef('');
  useEffect(() => {
    if (settingsGuild.current !== portal.guildId) {
      dirty.current = { volume: false, channel: false, role: false }; settingsGuild.current = portal.guildId;
      setVolume(String(settings?.volume ?? 100)); setChannel(settings?.musicTextChannelId || ''); setRole(settings?.djRoleId || '');
    }
    if (!settings || !snapshot) return;
    if (!dirty.current.volume) setVolume(String(settings.volume));
    if (!dirty.current.channel) setChannel(settings.musicTextChannelId || '');
    if (!dirty.current.role) setRole(settings.djRoleId || '');
  }, [settings, portal.guildId]);
  useEffect(() => { setReset(false); }, [portal.guildId]);
  useEffect(() => { if (!snapshot?.guild.admin && (tab === 'activity' || tab === 'diagnostics')) setTab('settings'); }, [snapshot?.guild.admin, tab]);
  const editable = admin && can('admin') && !pending.length && !!settings;
  const textChannels = configuration.data?.channels.filter(c => c.type === 'text') || [];
  const roles = configuration.data?.roles || [];
  const validChannel = textChannels.some(c => c.id === channel) || isDiscordId(channel);
  const validRole = !role || roles.some(r => r.id === role) || isDiscordId(role);
  const save = async (subcommand: string, options: Record<string, string | number | boolean | null>, field?: keyof typeof dirty.current) => {
    if (!editable) return false;
    const guildId = portal.guildId;
    const ok = await run({ command: 'settings', subcommand, options }, 'admin');
    if (ok && field && settingsGuild.current === guildId) dirty.current[field] = false;
    return ok;
  };
  const tabs = ['settings', ...(snapshot?.guild.admin ? ['activity', 'diagnostics'] : []), 'commands'] as const;
  return <div ref={view} className="server-view"><div className="tabs" role="tablist" aria-label="Server sections">{tabs.map(t => <button key={t} id={`server-tab-${t}`} role="tab" aria-selected={tab === t} aria-controls={`server-panel-${t}`} tabIndex={tab === t ? 0 : -1}
    onClick={() => setTab(t as typeof tab)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const index = tabs.indexOf(tab); const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; setTab(next as typeof tab); document.getElementById(`server-tab-${next}`)?.focus(); }}>{t === 'settings' ? 'Settings' : t === 'activity' ? 'Activity' : t === 'diagnostics' ? 'Diagnostics' : 'More controls'}</button>)}</div>
    <section role="tabpanel" id={`server-panel-${tab}`} aria-labelledby={`server-tab-${tab}`}>
      {tab === 'settings' && <><div className="section-heading"><div><h2>Your listening space</h2><p className="section-description">A few good defaults. The music does the rest.</p></div>{snapshot?.guild.admin && <span className="pill"><ShieldCheckIcon size={16} />Server manager</span>}</div>
        {!settings || !admin ? <div className="permission-note"><ShieldCheckIcon size={23} /><div><strong>Server settings need Manage Server permission.</strong><p>You can still add music, save favorites, and use the controls your voice and DJ access allow.</p></div></div> : <div className="settings-list">
          <div className="setting-row" role="group" aria-label="Channel and role options">
            <div><h3>Channel and role options</h3>{configuration.loading ? <p role="status"><span className="spinner" aria-hidden="true" /> Loading channel and role options…</p> : configuration.error ? <p role="alert">{configuration.error}</p> : <p>Refresh when channels or roles change. You can also use a Discord ID when names are unavailable.</p>}</div>
            <button type="button" className="button secondary" disabled={configuration.loading} onClick={configuration.reload}><ArrowClockwiseIcon size={18} />{configuration.error ? 'Try again' : 'Refresh options'}</button>
          </div>
          <form className="setting-row" onSubmit={event => { event.preventDefault(); if (validChannel) void save('musicchannel', { channel }, 'channel'); }}>
            <div><label htmlFor="music-channel">{textChannels.length ? 'Music text channel' : 'Music text channel ID'}</label><p>New web sessions post here. Active sessions keep their existing controller.</p>{!textChannels.length && <p id="music-channel-help">Channel names are unavailable for this account. Paste a Discord channel ID using digits only.</p>}</div>
            <div className="setting-action">{textChannels.length ? <select id="music-channel" value={channel} disabled={!editable} onChange={event => { dirty.current.channel = true; setChannel(event.target.value); }}><option value="">Choose a music channel</option>{channel && !textChannels.some(c => c.id === channel) && <option value={channel}>Channel ID: {channel}</option>}{textChannels.map(c => <option key={c.id} value={c.id}># {c.name}</option>)}</select> : <input id="music-channel" className="discord-id-input" type="text" inputMode="numeric" pattern={discordIdPattern} maxLength={20} required aria-describedby="music-channel-help" value={channel} disabled={!editable} onChange={event => { dirty.current.channel = true; setChannel(event.target.value); }} />}<button className="button secondary" disabled={!editable || !validChannel}>Save</button></div>
          </form>
          <form className="setting-row" onSubmit={event => { event.preventDefault(); void save('volume', { value: Number(volume) }, 'volume'); }}><div><label htmlFor="default-volume">Default volume</label><p>For new listening sessions. The player controls the current session.</p></div><div className="setting-action"><input id="default-volume" className="number-input" type="number" min="0" max="100" step="1" value={volume} disabled={!editable} onChange={event => { dirty.current.volume = true; setVolume(event.target.value); }} /><span>%</span><button className="button secondary" disabled={!editable || !volume || Number(volume) < 0 || Number(volume) > 100}>Save</button></div></form>
          <div className="setting-row"><div><h3>Fair queue</h3><p>Take turns between listeners, keeping each person’s songs in order.</p></div><button role="switch" aria-checked={settings.fairQueue} className="switch" aria-label="Fair queue" disabled={!editable} onClick={() => void save('fairqueue', { enabled: !settings.fairQueue })}><span />{settings.fairQueue ? 'On' : 'Off'}</button></div>
          <form className="setting-row" onSubmit={event => { event.preventDefault(); if (validRole) void save('djrole', role ? { role } : {}, 'role'); }}>
            <div><label htmlFor="dj-role">{roles.length ? 'DJ role' : 'DJ role ID'}</label><p>Playback controls still require the same voice channel, including for managers.</p>{!roles.length && <p id="dj-role-help">Role names are unavailable for this account. Paste a Discord role ID using digits only, or leave blank for everyone in voice.</p>}</div>
            <div className="setting-action">{roles.length ? <select id="dj-role" value={role} disabled={!editable} onChange={event => { dirty.current.role = true; setRole(event.target.value); }}><option value="">Everyone in voice</option>{role && !roles.some(r => r.id === role) && <option value={role}>Role ID: {role}</option>}{roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select> : <input id="dj-role" className="discord-id-input" type="text" inputMode="numeric" pattern={discordIdPattern} maxLength={20} aria-describedby="dj-role-help" value={role} disabled={!editable} onChange={event => { dirty.current.role = true; setRole(event.target.value); }} />}<button className="button secondary" disabled={!editable || !validRole}>Save</button></div>
          </form>
          <div className="setting-row"><div><h3>Reset listening defaults</h3><p>Restore default volume, open controls, and normal queue order.</p></div><button className="text-button danger-text" disabled={!editable} onClick={() => setReset(true)}>Reset defaults</button></div>
        </div>}
        <div className="personal-settings"><h2>Make yourself comfortable</h2><div className="settings-list"><div className="setting-row"><div><label htmlFor="ambient-mode">Ambient motion</label><p>Decorative artwork drift. Settles on pause and recovery; respects reduced motion.</p></div><select id="ambient-mode" value={ambient} onChange={event => setAmbient(event.target.value as AmbientMode)}><option value="on">Immersive</option><option value="subtle">Subtle</option><option value="off">Off</option></select></div>
          <div className="setting-row"><div><h3>Keep Vybertron close</h3><p>{installPrompt ? 'Install a small, dedicated window for your listening space.' : 'Use your browser’s Install app or Add to Home Screen option when available.'}</p></div><button className="button secondary" disabled={!installPrompt} onClick={install}><DownloadSimpleIcon size={19} />Install app</button></div>
          <div className="setting-row"><div><h3>This device’s session</h3><p>Discord sign-in lasts up to seven days per device.</p></div><button className="text-button" onClick={() => void portal.logout()}>Sign out</button></div>
        </div></div>
      </>}
      {tab === 'activity' && snapshot?.guild.admin && <ActivityView portal={portal} />}
      {tab === 'diagnostics' && snapshot?.guild.admin && <DiagnosticsView portal={portal} />}
      {tab === 'commands' && <SupplementalCommands portal={portal} />}
    </section>
    {reset && <Confirm title="Reset this server’s defaults?" detail="Restores the bot’s default listening settings. This follows the same rules as the Discord settings command." action="Reset defaults" busy={!!pending.length} onClose={() => setReset(false)} onConfirm={() => { void save('reset', {}).then(ok => { if (ok) setReset(false); }); }} />}
  </div>;
}

function useConfiguration(guildId: string, active: boolean) {
  const [state, setState] = useState<{ guildId: string; data: Configuration | null; loading: boolean; error: string }>({ guildId: '', data: null, loading: false, error: '' });
  const [key, setKey] = useState(0);
  const access = useRef({ guildId, active }); access.current = { guildId, active };
  useEffect(() => {
    if (!active) { setState({ guildId, data: null, loading: false, error: '' }); return; }
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && access.current.active && access.current.guildId === guildId;
    setState(previous => ({ guildId, data: previous.guildId === guildId ? previous.data : null, loading: true, error: '' }));
    void api.configuration(guildId, controller.signal).then(data => {
      if (!current()) return;
      if (data.guildId !== guildId || !Array.isArray(data.channels) || !Array.isArray(data.roles)) throw new ApiError(503, 'invalid_response', 'Channel and role options are unavailable. Try again.');
      setState({ guildId, data, loading: false, error: '' });
    }).catch(cause => {
      if (!current()) return;
      const denied = cause instanceof ApiError && [401, 403, 404].includes(cause.status);
      setState(previous => ({ guildId, data: denied || previous.guildId !== guildId ? null : previous.data, loading: false, error: errorMessage(cause) }));
    });
    return () => controller.abort();
  }, [guildId, active, key]);
  return { data: active && state.guildId === guildId ? state.data : null, loading: active && (state.guildId !== guildId || state.loading), error: active && state.guildId === guildId ? state.error : '', reload: () => setKey(previous => previous + 1) };
}

function useServerResource<T>(guildId: string, loader: (id: string, signal: AbortSignal) => Promise<T>) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [key, setKey] = useState(0);
  useEffect(() => { const controller = new AbortController(); setData(null); setLoading(true); setError(''); void loader(guildId, controller.signal).then(value => { if (!controller.signal.aborted) setData(value); }).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, [guildId, loader, key]);
  return { data, error, loading, reload: () => setKey(k => k + 1) };
}
const diagnosticsLoader = (id: string, signal: AbortSignal) => api.diagnostics(id, signal);
const activityLoader = (id: string, signal: AbortSignal) => api.activity(id, signal);
function ActivityView({ portal }: { portal: Portal }) {
  const { data, error, loading, reload } = useServerResource<Activity>(portal.guildId, activityLoader);
  return <><div className="section-heading"><div><h2>A little shared history</h2><p className="section-description">Successful queue and settings changes from the last 24 hours. Private favorites stay private.</p></div><button className="button secondary" onClick={reload} disabled={loading}><ArrowClockwiseIcon size={18} />Refresh</button></div>{error ? <ErrorState message={error} retry={reload} /> : loading ? <Loading label="Getting server activity…" /> : !data?.items.length ? <Empty title="A quiet moment" description="Successful server changes appear here with who made them." /> : <ol className="activity-list">{data.items.map(item => <li key={item.id}><CheckCircleIcon size={21} /><div><strong>{item.actor.displayName}<span>{item.action}</span></strong><p>{item.detail}</p></div><time dateTime={new Date(item.at).toISOString()}>{date(item.at)}</time></li>)}</ol>}</>;
}
function DiagnosticsView({ portal }: { portal: Portal }) {
  const { data, error, loading, reload } = useServerResource<Diagnostics>(portal.guildId, diagnosticsLoader);
  return <><div className="section-heading"><div><h2>Behind the music</h2><p className="section-description">Read-only connection and recovery health.</p></div><button className="button secondary" onClick={reload} disabled={loading}><ArrowClockwiseIcon size={18} />Refresh</button></div>{error ? <ErrorState message={error} retry={reload} /> : loading ? <Loading label="Checking the connections…" /> : data && <><dl className="diagnostic-list"><div><dt>Discord connection</dt><dd className={data.botReady ? 'healthy-text' : 'warm-text'}>{data.botReady ? <CheckCircleIcon /> : <WarningCircleIcon />}{data.botReady ? 'Ready' : 'Unavailable'}</dd></div><div><dt>Audio connection</dt><dd className={data.audioReady ? 'healthy-text' : 'warm-text'}>{data.audioReady ? <CheckCircleIcon /> : <WarningCircleIcon />}{data.audioReady ? 'Ready' : 'Unavailable'}</dd></div><div><dt>Bot uptime</dt><dd><ClockIcon />{totalTime(data.uptimeSeconds * 1000)}</dd></div><div><dt>Recovery</dt><dd>{data.recoveryState}</dd></div></dl>{data.lastError && <div className="inline-error"><WarningCircleIcon size={22} /><div><strong>Last reported error</strong><p>{data.lastError}</p></div></div>}<p className="permission-note">Diagnostics don’t interrupt playback. Recovery is managed by the bot.</p></>}</>;
}

function SupplementalCommands({ portal }: { portal: Portal }) {
  const schemas = portal.bootstrap?.commands || [];
  const [name, setName] = useState(''); const [subcommand, setSubcommand] = useState(''); const [group, setGroup] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<{ guildId: string; value: string; label: string; tokens: Pick<Command, 'expectedTrackId' | 'expectedHistoryId' | 'expectedMixVersion'> } | null>(null);
  const [deleteIntent, setDeleteIntent] = useState<Command | null>(null);
  useEffect(() => { setSelection(null); setDeleteIntent(null); }, [portal.guildId]);
  const schema = schemas.find(s => s.name === name);
  const groups = schema?.options?.filter(o => o.type === 2) || [];
  const subcommands = (group ? groups.find(g => g.name === group)?.options : schema?.options)?.filter(o => o.type === 1) || [];
  const fields = (subcommand ? subcommands.find(o => o.name === subcommand)?.options : schema?.options?.filter(o => o.type !== 1 && o.type !== 2)) || [];
  const capability: Capability = name === 'settings' ? 'admin' : name === 'voteskip' ? 'vote'
    : name === 'play' || name === 'favorite' && subcommand === 'play' || name === 'mix' && subcommand === 'load' ? 'add'
    : name === 'favorite' || name === 'mix' && ['save', 'list', 'delete'].includes(subcommand) ? 'library'
    : name === 'session' && subcommand === 'resume' ? 'resume' : 'control';
  const selectionField = name === 'favorite' && ['play', 'remove'].includes(subcommand) || name === 'replay' ? 'index'
    : name === 'mix' && subcommand === 'delete' ? 'name' : null;
  // Capture when the user chooses a displayed item, never when submitting or receiving a library update.
  const captureSelection = (value: string) => {
    if (!portal.library || portal.libraryError || !value.trim()) return null;
    const index = Number(value);
    if (name === 'favorite' && Number.isSafeInteger(index) && index > 0) {
      const track = portal.library.favorites[index - 1];
      if (track) return { guildId: portal.guildId, value, label: track.title, tokens: { expectedTrackId: track.id } };
    }
    if (name === 'replay' && Number.isSafeInteger(index) && index > 0) {
      const entry = portal.library.history[index - 1];
      if (entry) return { guildId: portal.guildId, value, label: entry.track.title, tokens: { expectedHistoryId: entry.id } };
    }
    if (name === 'mix') {
      const key = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');
      const mix = portal.library.mixes.find(item => key(item.name) === key(value));
      if (mix?.canEdit) return { guildId: portal.guildId, value, label: mix.name, tokens: { expectedMixVersion: mix.version } };
    }
    return null;
  };
  const selectionReady = !selectionField || !!portal.library && !portal.libraryError && !!selection && selection.guildId === portal.guildId && selection.value === values[selectionField];
  const allowed = portal.can(capability) && !portal.pending.length && !!name && !groups.length && selectionReady;
  const submit = async () => {
    if (!allowed) return;
    const options: Record<string, string | number | boolean | null> = {};
    for (const field of fields) {
      const value = values[field.name]; if (value === undefined || value === '') continue;
      options[field.name] = [4, 10].includes(field.type) ? Number(value) : field.type === 5 ? value === 'true' : value;
    }
    const command: Command = { command: name, ...(subcommand ? { subcommand } : {}), options, expectedRevision: portal.snapshot?.revision, ...(selectionField ? selection?.tokens : {}) };
    if (name === 'mix' && subcommand === 'delete') setDeleteIntent(command);
    else await portal.run(command, capability);
  };
  return <><div className="section-heading"><div><h2>Every music control, within reach</h2><p className="section-description">Forms come from Vybertron’s supported commands. Discord’s permissions still apply.</p></div><TerminalWindowIcon size={27} /></div>
    {!schemas.length ? <Empty title="Command forms aren’t available yet" description="The player, queue, and library controls still work. Refresh when the bot connection is ready." /> : <form className="command-form" onSubmit={event => { event.preventDefault(); void submit(); }}><label>Command<select aria-label="Command" value={name} onChange={event => { setName(event.target.value); setSubcommand(''); setGroup(''); setValues({}); setSelection(null); setDeleteIntent(null); }} required><option value="">Choose a command</option>{schemas.map(s => <option key={s.name} value={s.name}>/{s.name}</option>)}</select></label>{schema?.description && <p>{schema.description}</p>}
      {!!groups.length && <><label>Command group<select value={group} onChange={event => { setGroup(event.target.value); setSubcommand(''); setValues({}); setSelection(null); setDeleteIntent(null); }}><option value="">Choose a group</option>{groups.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}</select></label><p className="permission-note">Grouped commands are available in Discord. The portal contract currently supports a single subcommand.</p></>}
      {!!subcommands.length && <label>Action<select value={subcommand} required onChange={event => { setSubcommand(event.target.value); setValues({}); setSelection(null); setDeleteIntent(null); }}><option value="">Choose an action</option>{subcommands.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}</select></label>}
      {fields.map(field => <CommandField key={`${name}:${subcommand}:${field.name}`} field={field} value={values[field.name] ?? ''} setValue={value => { setValues(previous => ({ ...previous, [field.name]: value })); if (field.name === selectionField) setSelection(captureSelection(value)); }} portal={portal} />)}
      {selectionField && <div className="permission-note"><div>{selection && selection.guildId === portal.guildId ? <><strong>Selected: {selection.label}</strong><p>This keeps the item you chose. After a library change, review the current selection before trying again.</p></> : <p>Enter a {selectionField === 'index' ? 'library index' : 'mix name'} to select an item from your loaded library.</p>}<button type="button" className="text-button" disabled={!portal.library || !!portal.libraryError || portal.connection !== 'live' || !!portal.pending.length || !values[selectionField]} onClick={() => setSelection(captureSelection(values[selectionField]))}>Review current selection</button></div></div>}
      {name && !portal.can(capability) && <p className="permission-note">{capability === 'admin' ? 'Manage Server permission is required.' : portal.blockedReason}</p>}
      <button className="button primary" disabled={!allowed || !!subcommands.length && !subcommand}><GearSixIcon size={19} />Run command</button>
    </form>}
    {deleteIntent && <Confirm title={`Delete “${deleteIntent.options?.name}”?`} detail="Removes the selected saved version of this shared mix. The live queue stays in place." action="Delete mix" busy={!!portal.pending.length} onClose={() => setDeleteIntent(null)} onConfirm={() => { void portal.run(deleteIntent, 'library').then(ok => { if (ok) setDeleteIntent(null); }); }} />}
  </>;
}
function CommandField({ field, value, setValue, portal }: { field: CommandOption; value: string; setValue: (value: string) => void; portal: Portal }) {
  const common = { value, required: field.required, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setValue(event.target.value) };
  const catalog = field.type === 7 ? portal.snapshot?.channels : field.type === 8 ? portal.snapshot?.roles : undefined;
  const discordField = field.type === 7 || field.type === 8;
  return <label>{field.name}{field.required && <span className="required-label">Required</span>}{field.choices?.length ? <select {...common}><option value="">Choose {field.name}</option>{field.choices.map(c => <option key={c.value} value={String(c.value)}>{c.name}</option>)}</select> : field.type === 5 ? <select {...common}><option value="">Choose an option</option><option value="true">Yes</option><option value="false">No</option></select> : discordField ? catalog?.length ? <select {...common}><option value="">Choose {field.type === 7 ? 'channel' : 'role'}</option>{catalog.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select> : <input {...common} type="text" inputMode="numeric" pattern={discordIdPattern} maxLength={20} aria-label={`${field.name} ID`} title={`Enter a Discord ${field.type === 7 ? 'channel' : 'role'} ID using digits only (up to 20).`} /> : <input {...common} type={[4, 10].includes(field.type) ? 'number' : 'text'} min={field.min_value} max={field.max_value} minLength={field.min_length} maxLength={field.max_length || 200} step={field.type === 4 ? 1 : field.type === 10 ? 'any' : undefined} />}{discordField && !catalog?.length && <small>Paste a Discord {field.type === 7 ? 'channel' : 'role'} ID using digits only.</small>}{field.description && <small>{field.description}</small>}</label>;
}
