export interface Viewer {
  id: string; username: string; displayName: string; avatarUrl: string | null; maintainer: boolean;
}
export interface Guild { id: string; name: string; iconUrl: string | null; admin: boolean }
export interface Channel { id: string; name: string; type: 'voice' | 'text' }
export interface Configuration { guildId: string; channels: Channel[]; roles: { id: string; name: string }[] }
export interface Track {
  id: string; title: string; author: string; uri: string | null; source: string;
  durationMs: number; artworkUrl: string | null; isStream: boolean;
  requestedBy: { id: string; displayName: string; avatarUrl: string | null } | null;
  // Session tracks only: true for autoplay picks, which the bot requested.
  suggested?: boolean;
}
export type AutoplayMode = 'off' | 'on' | 'listening';
export interface CommandOption {
  name: string; description?: string; type: number; required?: boolean;
  choices?: { name: string; value: string | number }[]; options?: CommandOption[];
  min_value?: number; max_value?: number; min_length?: number; max_length?: number;
}
export interface CommandSchema { name: string; description?: string; options?: CommandOption[] }
export interface Bootstrap {
  viewer: Viewer; guilds: Guild[]; csrfToken: string;
  // The listed server whose voice the viewer is in when the portal loaded.
  voiceGuildId?: string | null;
  filters: { id: string; label: string; description: string }[];
  commands: CommandSchema[];
}
// Transport reconciliation only; never authority or a mutation revision.
export interface SnapshotOrdering { instanceId: string; sequence: number }
export interface GuildSnapshot {
  guild: Guild; revision: string;
  ordering?: SnapshotOrdering;
  session: {
    status: 'idle' | 'playing' | 'paused' | 'recovering' | 'unavailable';
    voiceChannel: { id: string; name: string } | null; textChannel: { id: string; name: string } | null;
    current: Track | null; queue: Track[]; positionMs: number; durationMs: number;
    // Autoplay picks waiting after the queue (suggested: true). Not part of the queue.
    suggestions: Track[];
    volume: number; filter: string; repeat: 'off' | 'track' | 'queue';
    // radio: autoplay is active for this session (server mode or /radio override).
    radio: boolean; autoplay: AutoplayMode; fairQueue: boolean;
    listeners: { id: string; displayName: string; avatarUrl: string | null }[];
    canAdd: boolean; canControl: boolean; canVote: boolean; reason: string | null;
    // The viewer's own voice channel in this server; older bots omit it.
    viewerVoice?: { id: string; name: string } | null;
  };
  savedSession: {
    exists: boolean; savedAt: number | null; positionMs: number; paused: boolean;
    trackCount: number; voiceChannel: { id: string; name: string } | null; canResume: boolean;
  };
  settings: { volume: number; fairQueue: boolean; autoplay: AutoplayMode; djRoleId: string | null; musicTextChannelId: string | null } | null;
  channels: Channel[]; roles: { id: string; name: string }[];
}
export interface Library {
  favorites: Track[];
  mixes: { id: string; name: string; ownerId: string; version: string; tracks: Track[]; canEdit: boolean }[];
  history: { id: string; playedAt: number; voiceChannel: { id: string; name: string } | null; track: Track }[];
}
// Play statistics. Lists include only plays in voice channels the viewer can see.
export interface StatEntry { track: Track; plays: number; lastPlayedAt: number }
export type StatsWindow = '7d' | '30d' | '90d' | '365d' | 'all';
export interface Stats {
  serverFavorites: { onRepeat: StatEntry[]; forgottenGems: StatEntry[] };
  personal: {
    window: StatsWindow;
    topTracks: StatEntry[];
    topArtists: { name: string; plays: number; lastPlayedAt: number; track: Track }[];
    // index is the one-based favorites position; track.id is its expectedTrackId.
    rediscover: { index: number; track: Track; requests: number; lastRequestedAt: number | null }[];
    // Generated on read from the viewer's own requests and favorites.
    playlists: AutoPlaylist[];
  };
}
export type PlaylistKind = 'mix' | 'top' | 'rediscover' | 'artist';
export interface AutoPlaylist {
  id: string; kind: PlaylistKind; title: string; artist: string | null; tracks: Track[];
  // Your mix picks new songs at this time (Monday 00:00 UTC); null when live.
  refreshesAt: number | null;
}
export interface Diagnostics {
  botReady: boolean; audioReady: boolean; uptimeSeconds: number; recoveryState: string; lastError: string | null;
}
export interface Activity {
  items: { id: string; at: number; actor: { id: string; displayName: string }; action: string; detail: string }[];
}
export interface Command {
  command: string; subcommand?: string; options?: Record<string, string | number | boolean | null>; expectedRevision?: string;
  expectedTrackId?: string; expectedHistoryId?: string; expectedMixVersion?: string;
  // transfer only: public links for the current song, then the queue.
  tracks?: string[];
}
export interface CommandResult { ok: true; message: string; snapshot: GuildSnapshot }
export type Connection = 'connecting' | 'refreshing' | 'live' | 'offline';
export type Capability = 'add' | 'control' | 'vote' | 'library' | 'admin' | 'resume';
export type Surface = 'home' | 'session' | 'music' | 'server';
