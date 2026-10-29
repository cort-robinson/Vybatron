# Portal integration contract

The shared contract between the bot bridge, the portal API and the web UI. Change
all three together; do not invent incompatible paths or names. JSON uses camelCase. Dates are epoch milliseconds. Track positions
and command indices are one-based. Durations/positions are milliseconds.

## Components and deployment boundary

- Bot bridge: `src/portal/**`. Exports
  `startPortalBridge(client, options)` with close/dispose handling. Optional bridge
  defaults disabled unless `PORTAL_BRIDGE_TOKEN` is set. Bind
  `PORTAL_BRIDGE_HOST` (default loopback; Compose uses 0.0.0.0) and
  `PORTAL_BRIDGE_PORT` (default 3010). Never publish bridge host ports.
- Portal API: `portal/server/**`, a Node HTTP
  service listens on `PORTAL_HOST`/`PORTAL_PORT` (default 3001); serves build from
  `PORTAL_WEB_DIST` (default sibling `../web/dist`). Uses `PORTAL_BOT_URL` (private
  bridge origin), `PORTAL_BRIDGE_TOKEN`, `PORTAL_ORIGIN`, `DISCORD_CLIENT_ID`,
  `DISCORD_CLIENT_SECRET`, `PORTAL_SESSION_SECRET`, `PORTAL_DATA_DIR`.
- Web UI: `portal/web/**`, guided by `portal/PRODUCT.md` and `portal/DESIGN.md`.
  Vite proxies `/api` and `/auth` to localhost:3001; configurable VITE_API_PROXY.

Bot bridges trust only their constant-time validated secret and a session-derived
actorId. Bot rechecks Discord member/owner/Manage Server/DJ/channel/voice state.
Portal NEVER accepts actorId/roles/voice/maintainer from browser data. Portal
music storage is not shared with bot music JSON. Auth cookies/tokens remain server-side.

## JSON types

`Viewer = { id, username, displayName, avatarUrl: string|null, maintainer: boolean, autoplayTaste?: boolean }`
(`autoplayTaste`: whether room autoplay uses this listener's taste, ADR-0012; older bots omit it)

`Guild = { id, name, iconUrl: string|null, admin: boolean }`

`Track = { id: string, title: string, author: string, uri: string|null,
  source: string, durationMs: number, artworkUrl: string|null, isStream: boolean,
  requestedBy: {id, displayName, avatarUrl: string|null}|null, suggested?: boolean }`

`LyricsResponse = { trackId: string|null, status: idle|found|not_found|unavailable,
  lyrics: { source: string, provider: string|null, synced: boolean,
  lines: {startMs: number|null, text: string}[] }|null }`

`SongAnalysis = { version: 1, status: 'ready', frameRate: 30, frameCount: number,
  bandCount: 16, bandHz: number[17], durationMs: number, tempo: number|null,
  levels: string, onsets: number[], beats: number[] } | { version: 1, status: 'pending', retryMs: number }`

A song's energy map for the portal's visualizers, measured once by the bot from the
same Ogg Opus as this device's player and looked up in the browser by playback
position, for Discord playback and this device alike. The browser never analyses
audio itself. `levels` is base64 of `frameCount × 16` bytes, frame-major: byte
`i * 16 + b` is band `b`'s level (0–255) in the Hann window centred on `i / 30` s.
Bands are log-spaced between the edges in `bandHz` (40 Hz to 16 kHz), in decibels
with half of each band's typical level removed and mapped per song from about its
quiet floor to its loudest 0.5%, so quiet songs move as much as loud ones.
`onsets` are spectral-flux onsets and `beats` bass-weighted ones, both in ms,
ascending; `tempo` is beats per minute from the bass envelope's repetition (60–200,
null when it has none). At most 20 minutes (36,000 frames). `pending`: the bot is
still measuring the song; ask again after `retryMs`. JSON with base64 levels keeps it
on the existing JSON bridge and its checks; base64 adds a third, and the portal
compresses replies. A four-minute song is about 160 KB, 7200 frames.
`version` changes with any incompatible change to the fields or their meaning.

Lyrics belong to the session's current song (`trackId` is its public Track id, null
with `idle` when nothing visible is playing). Synced lyrics carry each line's start
in track milliseconds; plain lyrics have `startMs: null`. Empty `text` is a verse
break. At most 1000 lines of 300 characters. `unavailable` means the audio server
or its lyrics source failed (or lacks the LavaLyrics plugin); it is retried on the
next read, while found and not-found answers are cached per song for 30 minutes.
When LavaLyrics finds nothing or fails, the bot asks LRCLIB's search API directly
(6 s bound, title and artist only), first by the song's own title and artist, then by
an upload title read as "Artist - Song" (such as "Artist - Song (Official Video)"
from another channel). A result counts only within 3 seconds of the song's length
and when not instrumental; synced lines are preferred. This also covers LavaSrc
4.8.3, which fails on LRCLIB lines with no space after the timestamp.

`suggested` appears on session tracks only (current, queue, suggestions): true for
smart-autoplay picks, whose `requestedBy` is the bot. Library tracks omit it.

Track ids are public-reference identities, NEVER encoded Lavalink tracks. All
fields are bounded safe projections. No signed media URLs, credentials, raw
library documents, private favorites of other accounts or unrestricted images.
Missing artwork uses the bundled fallback. Queue positions are array index + 1.

`Bootstrap = { viewer: Viewer, guilds: Guild[], csrfToken: string,
  filters: {id, label, description}[], commands: object[] }`

Commands may contain the bot's safe public slash-command schemas (names,
descriptions, subcommands/options/choices), useful for auxiliary forms. Exclude
runtime objects and credential-bearing data. Maintain existing command meanings.

`GuildSnapshot = {
  guild: Guild, revision: string, ordering?: {instanceId:string, sequence:number},
  session: {
    status: 'idle'|'playing'|'paused'|'recovering'|'unavailable',
    voiceChannel: {id,name}|null, textChannel: {id,name}|null,
    current: Track|null, queue: Track[], suggestions: Track[], hasPrevious: boolean,
    positionMs: number, durationMs: number,
    volume: number, filter: string, repeat: 'off'|'track'|'queue',
    radio: boolean, autoplay: 'off'|'on'|'listening', fairQueue: boolean,
    sleep: {mode:'time', endsAt:number}|{mode:'track'}|null,
    listeners: {id,displayName,avatarUrl:string|null}[],
    canAdd: boolean, canControl: boolean, canVote: boolean, reason: string|null,
    viewerVoice: {id,name}|null
  },
  savedSession: {exists:boolean, savedAt:number|null, positionMs:number,
    paused:boolean, trackCount:number, voiceChannel:{id,name}|null,
    canResume:boolean},
  settings: {volume:number,fairQueue:boolean,autoplay:'off'|'on'|'listening',djRoleId:string|null,
    musicTextChannelId:string|null}|null,
  channels: {id,name,type:'voice'|'text'}[], roles:{id,name}[]
}`

If session channel is not visible, expose an idle/empty projection and a safe
reason; do not reveal restricted channel ids/name/tracks/listeners/checkpoint.
`suggestions` holds at most three autoplay picks waiting after the queue (ADR-0008);
they are not queue positions and are empty when hidden or inactive. `radio` is
whether autoplay is active for the session (server `autoplay` mode or a /radio
override). Clients must treat missing `suggestions`/`autoplay` as empty/off.
`sleep` is the session's sleep timer: `time` stops at `endsAt` (epoch ms), `track`
stops when the current track finishes. It is null when unset or hidden; clients must
treat a missing field as null.
`hasPrevious` is whether this session has an earlier track for `back` to return
to; clients must treat it as false when missing.
`viewerVoice` is the actor's own visible voice channel in this guild, or null; clients
play on their own device when it is null and treat a missing field (an older bot) as in voice.
Settings/channels/roles include only authorized fields; settings null for basic
members. Snapshot channels are the relevant, freshly verified session channels;
the complete settings catalog is discovered separately on demand. Revision changes on queue/current identity and relevant state changes,
not continuously on time interpolation. Compare revision INSIDE the mutation
lane for queue conflicts; web queue edits must not race a Discord edit/track end.

Production snapshots carry `ordering`: a random UUID identifying the current
bridge lifetime and a strictly increasing safe integer allocated synchronously
at projection capture across GET and command results. It is reconciliation
metadata, never a permission grant or replacement for expectedRevision. Clients
can compare only validated stamps from the same instance while the guild,
generation, connection-loss and freshness fences remain valid. Older/equal
frames do not refresh the authorization lease. Different instances, missing or
invalid stamps and uncertain/lost connections require conservative fresh reads.
Ordering has no actor identity, request payload or music fields; restart creates
a new instance. Legacy clients ignore this additive field.

`Library = { favorites: Track[],
  mixes: {id:string,name:string,ownerId:string,version:string,tracks:Track[],canEdit:boolean}[],
  history: {id:string,playedAt:number,voiceChannel:{id,name}|null,track:Track}[] }`

Favorites are global for ONLY the actor. Mixes are current guild. History respects
original channel visibility. Lists are bounded by approved retention/limits.

`Diagnostics = { botReady:boolean, audioReady:boolean, uptimeSeconds:number,
  recoveryState:string, lastError:string|null }`

`Configuration = { guildId:string, channels:{id:string,name:string,type:'voice'|'text'}[],
  roles:{id:string,name:string}[] }`

Configuration discovery is admin-only, includes only currently visible channels,
and retains the 500-channel/250-role bounds. Fetch once when opening server settings,
switching guilds, or explicitly refreshing options; never on each live snapshot.
Configuration choices do not authorize a mutation. See
[`portal-channel-read-contract.md`](portal-channel-read-contract.md) for channel
scopes, fresh individual reads, input preservation, and revocation fences.

`Activity = { items:{id:string,at:number,actor:{id,displayName},action:string,
  detail:string}[] }` (admin-only, 24h, bounded, successful queue/settings only).

`StatEntry = { track: Track, plays: number, lastPlayedAt: number }`

`Stats = {
  serverFavorites: { onRepeat: StatEntry[], forgottenGems: StatEntry[] },
  personal: { window: '7d'|'30d'|'90d'|'365d'|'all',
    topTracks: StatEntry[],
    topArtists: { name: string, plays: number, lastPlayedAt: number, track: Track }[],
    rediscover: { index: number, track: Track, requests: number, lastRequestedAt: number|null }[],
    playlists: AutoPlaylist[] }
}`

`AutoPlaylist = { id: 'your-mix'|'top-tracks'|'rediscover'|'artist-1'|'artist-2'|'artist-3',
  kind: 'mix'|'top'|'rediscover'|'artist', title: string, artist: string|null,
  tracks: Track[], refreshesAt: number|null }`

Play statistics ([ADR-0006](adr/0006-play-statistics-store-and-song-identity.md)). Every
list holds at most 25 entries (topArtists 10). Only plays in voice channels the actor can
currently see contribute to serverFavorites, topTracks and topArtists; a nonmember sees empty
guild lists. Server lists never identify requesters, and their Track.requestedBy is null.
`plays` counts visible plays that were not early skips; On repeat uses the last 90 days and
Forgotten gems the window 60-120 days ago. Personal lists use only the actor's own requests:
topTracks/topArtists in this guild within `window` (default `30d`); `rediscover` lists the
actor's global favorites not requested anywhere in 30 days, previously requested songs first.
Its one-based `index` and `track.id` are the `favorite/play` index and `expectedTrackId`.
`playlists` are personal auto-playlists ([ADR-0007](adr/0007-personal-auto-playlists-computed-on-read.md)),
computed on read and never stored: always `your-mix`, `top-tracks` (same `window`) and
`rediscover`, then up to three `artist-N` mixes for the actor's top artists over 90 days.
Each holds at most 25 tracks. Your mix blends the actor's 90-day top requests with their
favorites using a weekly seed; `refreshesAt` is when it next changes (Monday 00:00 UTC), null
for the others. Artist mixes add visible server plays by that artist without requesters.
Stats are optional: an unavailable store returns 503 `stats_unavailable` and nothing else
changes. Fetch on demand; stats are not part of snapshots or the change feed.

`RecapTotals = { plays: number, playedMs: number, songs: number }`

`Recap = { window: '7d'|'30d'|'90d'|'365d', since: number,
  personal: RecapTotals & { topTracks: StatEntry[],
    topArtists: { name: string, plays: number, lastPlayedAt: number, track: Track }[] },
  server: RecapTotals & { topTracks: StatEntry[] } }`

A listening recap for plays since `since` (now minus `window`, default `30d`), computed on
read under the Stats rules: only plays in voice channels the actor can currently see, and a
nonmember gets zeros. `personal` counts only the actor's own requests in this guild: `plays`
is every request including early skips, `songs` the distinct songs, and topTracks (at most 10)
and topArtists (at most 5) exclude early skips like the Stats lists. `server` counts every
visible play, including autoplay, imported and cleared ones, without identifying requesters;
its topTracks (at most 10) exclude early skips. `playedMs` sums recorded playback time, so
imported history and plays still in progress add none. Nothing describes who was listening.
Unavailable stats return 503 `stats_unavailable`.

## Public browser endpoints (portal API)

- GET `/health`: credential-free portal responsiveness/readiness, never music data.
- GET `/auth/discord`: OAuth code flow with state (PKCE when supported), exact
  registered callback `${PORTAL_ORIGIN}/auth/discord/callback`.
- GET `/auth/discord/callback`: verified Discord identity, establish a device
  session; redirect `/`. No token/session ids in URLs/logs.
- Session lifetime (ADR-0019): a session ends after 30 days without use and in any
  case 90 days after sign-in. An authenticated `/api/*` request, command or code
  approval renews it at most once a day: its expiry moves to 30 days from then (never
  past the 90-day limit), the response resends the session cookie with the new
  `Max-Age`, and only then is the encrypted store written. Stored records keep
  `createdAt` and, once renewed, `renewedAt`; the loader keeps records from before
  renewal (`expiresAt = createdAt + 7 days`) and renewed ones within their bounds
  (`expiresAt <= renewedAt + 30 days` and `<= createdAt + 90 days`), and drops any
  other record instead of refusing to start. The 4096-session cap and the
  replacement of a session signed in over are unchanged.
- POST `/auth/logout`: same-origin + CSRF checked, destroy this device session.

Signing in with a code (ADR-0019), for a screen without a convenient keyboard. Pending
sign-ins live in the portal's memory only (a restart loses them), at most 64 at once,
each for 10 minutes. `start` and `poll` come before any session, so instead of a CSRF
token they need the exact portal `Origin` and a JSON body (`Content-Type:
application/json`); anything else is 403 or 400.

- POST `/auth/device/start`, body `{}` -> `{userCode: 'XXXX-XXXX', verificationUri:
  '${PORTAL_ORIGIN}/link', expiresIn: 600, interval: 5}`. The user code is 8 letters from
  `BCDFGHJKLMNPQRSTVWXZ`. Sets `__Host-vybertron_device_sign_in` (random device token;
  `HttpOnly; Secure; SameSite=Lax; Max-Age=600`) and drops the pending sign-in that
  cookie held before. 20 starts per address per minute, inside the anonymous budget;
  429 at the pending cap.
- POST `/auth/device/approve`, body `{code}` (case, spaces and the hyphen ignored):
  session + same origin + CSRF. Records the approving listener once; a wrong, expired,
  denied, already approved or malformed code is one 400 `invalid_code`. 10 tries
  (approve or deny, right or wrong) per session per 10 minutes, then 429.
- POST `/auth/device/deny`, body `{code}`: as approve; the screen's next poll hears
  `denied`.
- POST `/auth/device/poll`, body `{}`, with the device cookie -> `{status: 'pending' |
  'approved' | 'denied' | 'expired'}` (no cookie or an unknown one is `expired`; 30
  polls per device per minute). `denied` and `expired` clear the device cookie. On
  approval the pending sign-in is claimed and removed before anything is awaited, so
  one approval makes at most one session; then the bot's `/v1/bootstrap` checks the
  approving listener (as after Discord sign-in, errors as there), a new independent
  session is created and its cookie set, and the device cookie is cleared.
- The web app's `/link?code=XXXX-XXXX` shows the approval to a signed-in listener (the
  code is read once and the address bar reset to `/`).
- GET `/api/bootstrap` -> Bootstrap. Signed-out: 401 JSON error.
- GET `/api/guilds/:guildId` -> GuildSnapshot.
- GET `/api/guilds/:guildId/configuration` -> Configuration (admin only).
- GET `/api/guilds/:guildId/library` -> Library.
- GET `/api/guilds/:guildId/search?query=...` -> `{tracks:Track[],notice:string|null}`.
- POST `/api/guilds/:guildId/commands` -> command result below.
- GET `/api/guilds/:guildId/diagnostics` -> Diagnostics (admin only).
- GET `/api/guilds/:guildId/activity` -> Activity (admin only).
- GET `/api/guilds/:guildId/stats?window=7d|30d|90d|365d|all` -> Stats. Only `window` is
  accepted; omitted means `30d`.
- GET `/api/guilds/:guildId/lyrics` -> LyricsResponse for the current song. No query.
  Session channel visibility, like the snapshot. Fetched on demand, never in snapshots.
- GET `/api/guilds/:guildId/lyrics/:videoId` (11-character YouTube id) -> LyricsResponse
  for a song playing on this device. No query. Membership only, like its audio.
- GET `/api/guilds/:guildId/analysis/:videoId` (11-character YouTube id) -> SongAnalysis.
  No query. Membership only, like its audio. A `ready` reply never changes for its
  video and is sent `Cache-Control: private, max-age=604800, immutable`; `pending` and
  errors are `no-store`. The portal checks the shape and forwards only the fields above
  (`retryMs` bounded to 0.5–30 s). 404: the song can't be analysed (the YouTube stream
  fallback's `audio/mp4` or `audio/webm`, an unreadable song or one over 20 minutes);
  429: the bot is busy. Pages fetch it only while a visualizer is open, and stay on
  generated motion when it fails.
- GET `/api/guilds/:guildId/recap?window=7d|30d|90d|365d` -> Recap. Only `window` is
  accepted; omitted means `30d`.
- POST `/api/stats/requests/clear` -> `{ok:true,cleared:number}`. Same-origin + CSRF, no body.
  Anonymizes the signed-in listener's recorded requests in every server; server totals remain.
- POST `/api/preferences/autoplay-taste/on|off` -> `{ok:true,enabled:boolean}`. Same-origin +
  CSRF, no body. Whether room autoplay uses the signed-in listener's taste, in every server.
- GET `/api/guilds/:guildId/audio/:videoId` (11-character YouTube id): this device's
  player. Audio only (`audio/ogg` Opus from the vybatron-audio Lavalink plugin; the
  YouTube stream route's `audio/mp4` or `audio/webm` as a fallback), served with
  `Accept-Ranges: bytes`. A request from the start of a song still arriving streams at
  once without a length; other ranges wait for the whole song, then a single
  `Range: bytes=a-b` is honored (206) or rejected (416). Membership only, like search.
  Only audio bodies up to 40 MiB pass through; errors keep the sanitized JSON shape. A
  separate four-stream pool keeps slow phones off command slots.
- GET `/api/guilds/:guildId/events[?protocol=2]`: credentialed same-origin SSE. `event:snapshot`
  carries GuildSnapshot. Heartbeat comments. Permission/session loss closes
  stream; state-unavailable must not replay writes. Bound connections, polling,
  buffers, requests and payloads; current policy before protected data and fresh
  policy before mutations (ADR-0011).
  With `protocol=2` a read that would show this viewer nothing new sends
  `event:unchanged` with `{revision, ordering}` instead of the snapshot; it
  renews freshness only when the page shows exactly the stream's last snapshot.
  Every stream ends its lifetime with `event:rotate` (`{}`) before closing;
  pages open the next stream at once. Streams and JSON replies other than
  bootstrap are gzip/brotli compressed when the browser accepts it.

### Shared player (ADR-0018)

Each signed-in listener has one player shared by their devices
([ADR-0018](adr/0018-your-player-follows-you-across-devices.md)). The bot's
listening-state store keeps it; the portal relays controls to the device that
plays and pushes every change to the listener's streams. Each page opens the
listener stream while signed in, plays the player while it is the active device
(the Android app's playback service keeps its own stream and reports for the app, page or no
page, when `app.info` lists `player.shared`; for older apps the page reports) and controls it from
anywhere else.

`PlayerTrack = { id: string<=64, title: string<=200, author: string<=200, uri: https string<=512,
  source: string<=40, durationMs: number, artworkUrl: https string<=512|null, isStream: boolean }`
(a Track without `requestedBy`/`suggested`, which the portal drops).
`Entry = { entryId: string (12 base64url characters, made by the store), track: PlayerTrack }`.
`Player = { guildId: string|null, revision: number, generation: number, generationAt: number,
  activeDeviceId: string|null, playbackVersion: number, current: Entry|null, queue: Entry[] (<=500),
  history: Entry[] (<=50, newest first), playhead: { positionMs: number, at: number (server ms),
  playing: boolean }, volume: 0-100, repeat: 'off'|'track'|'queue', updatedAt: number }`.
`revision` changes with the current song, queue or history; `playbackVersion` with a song change,
play, pause or seek; `generation` each time a device becomes the active one. Without an active
device the player is paused. `updatedAt` strictly increases with every change.
`Device = { deviceId: string (22 base64url characters, random, kept by the device),
  name: string<=40, kind: 'browser'|'android'|'tv', lastSeen: number, connected: boolean,
  active: boolean }`: at most 10 per listener, the least recently seen forgotten first, and
any unseen for 30 days. `connected` means the device has a listener stream open to this portal.
Every change to the player or the device list advances `updatedAt`, which versions the
whole PlayerView. `PlayerView = { player: Player, devices: Device[] }`.

- GET `/api/me/time` -> `{now:number}`, the portal's clock in ms for round-trip clock sync.
  No query.
- GET `/api/me/events?device=<deviceId>&kind=<kind>&name=<name>&protocol=1`: credentialed
  same-origin SSE for the signed-in listener. Opening it registers the device (or marks it seen)
  for this session. `event:player` carries PlayerView, at once and after every change by any of
  the listener's devices. `event:command` carries `{action, value?, generation}`, a control
  relayed to this device because it is the active one (actions as in `control` below); a
  device ignores one whose generation isn't the one it plays under. Heartbeat comments and
  `event:rotate` as on the server stream. It counts toward the same stream limits
  (`streamsPerSession` 4). Sign-out and signing in over the session close it and forget the
  devices that session registered.
- POST `/api/me/player` body `{op, ...}` -> `{ok:true, relayed:false, player, devices[, dropped]}`
  (PlayerView), or `{ok:true, relayed:true}` for a control sent to the active device.
  Same-origin + CSRF + rate limits like commands; bodies within 16 KiB.
  - Edits, against the revision the device saw: `add {expectedRevision, tracks: PlayerTrack[1-50],
    position: 'next'|'end'|{after: entryId}, guildId?}` (to an empty player the first song
    becomes current), `remove {expectedRevision, entryId}`, `move {expectedRevision, entryId,
    before: entryId|null}` (null: to the end), `clear {expectedRevision}`, `shuffle
    {expectedRevision}`, `play {expectedRevision, tracks: PlayerTrack[1-50], startIndex,
    guildId?}` (the list replaces the queue from `startIndex`; send the rest with `add`),
    `skipTo {expectedRevision, entryId}` (the songs before it are skipped).
  - From the active device: `report {deviceId, generation, seq, advance?: {from: entryId|null,
    to: entryId|null, track?: PlayerTrack}, playhead?: {entryId: entryId|null, positionMs, at,
    playing}, volume?, repeat?}`. `seq` numbers the device's reports from 1 in each generation; a
    report at or below the last one applied changes nothing, so offline reports are sent again in
    order on reconnecting. `at` is server time; a playhead naming a song that isn't current (after
    the report's advance) is ignored. An advance makes `to` current wherever it is: from the queue
    (`from` goes to history) or from history (going back: `from` waits at the front of the
    queue). A `to` in neither needs `track`. Report every song change, play,
    pause and seek, and the position every 15 s while playing.
    `deactivate {deviceId, generation}` pauses and leaves no active device.
  - `activate {deviceId, guildId?}`: a registered device becomes the active one, generation + 1
    from now, at the playhead's position (moved on if it was playing). A plain resume: the
    previous device sees the new generation on its stream and stops.
  - `control {action: 'play'|'pause'|'seek'|'next'|'previous'|'volume'|'repeat', value?}`
    (`seek`: ms, `volume`: 0-100, `repeat`: mode; no value otherwise). Relayed to the active
    device while it is connected here; otherwise applied to the stored player.
  - `adopt {tracks?: PlayerTrack[0-50], current?: PlayerTrack|null, positionMs?, volume?, repeat?,
    guildId?}`: a device's old `vybertron.local` deck, in batches. Songs join the end of the
    queue; to an empty player the first becomes current with the deck's place, volume and
    repeat. `dropped` counts songs past the bounds.
  - Devices: `rename {deviceId, name}`, `forget {deviceId}`. Forgetting the active device
    pauses the player.
  - A `guildId` names the server the player plays through and requires membership there.
  Errors: 409 `stale` (an edit against an old revision) and 409 `replaced` (a report or
  `deactivate` from a device that is no longer the active one under that generation) carry
  `player`, the player as it now is; 400 `queue_full` ("Your queue is full.": over 500 songs or
  256 KiB), 400 `unknown_entry`, 404 `unknown_device`, 403 `membership_required`.

Mutations require `X-CSRF-Token` from bootstrap and exact same-origin checks.
Use HttpOnly/Secure/SameSite cookies and no-store API/auth responses. Do not
cache private API data in service worker. Production rejects demo/test auth.
Optional local fixture adapter allowed ONLY explicit nonproduction, loopback
with independent mock actor; public production build must never activate it.

Command body: `{command:string,subcommand?:string,
  options?:Record<string,string|number|boolean|null>,expectedRevision?:string,
  expectedTrackId?:string,expectedHistoryId?:string,expectedMixVersion?:string,
  tracks?:string[]}`. `tracks` is accepted only on `transfer`.
No actor or authority fields accepted. Strict whitelist command/options/schema.
Route through existing trusted command implementations/guards/lane semantics.
Response `{ok:true,message:string,snapshot:GuildSnapshot}`. Only safe text from
the command reply; never raw Discord interaction/token objects or embeds with secrets.

Core playback command names and options: play/playnext(query), pause/resume,
seek(timestamp), skip/skipto(position), back, stop, clear, remove(position), move(from,to),
shuffle, loop(mode:off|track|queue), volume(level), filter(preset), voteskip,
radio on(track?)/off/promote(position)/remove(position)/less(position?), replay(index),
sleep in(minutes: 1-720)/after-track/cancel/show (Stop's DJ and voice rules, no revision;
show is a read like nowplaying),
session resume/discard. radio promote/remove/less carry `expectedTrackId` (the
selected suggestion, or the current autoplay pick for less without a position);
promote is an ordinary addition (the pick stays bot-requested and `suggested`), the others need playback control.
Server favorites:
top show(list?: on-repeat|forgotten-gems, page?: 1-3) and top play(list?, shuffle?: boolean).
`top play` is an ordinary addition (canAdd rules, no revision) that resolves the actor's
visible list fresh inside the mutation lane and enqueues it through the normal path,
respecting the 500-track queue limit. Personal playlists: mymix show(playlist?: mix|top|rediscover|artist,
artist?: string<=100, window?: 7d|30d|90d|365d|all, page?: 1-3) and mymix play(playlist?, artist?, window?,
shuffle?: boolean). `mymix play` follows the same canAdd rules as `top play` and resolves the
actor's playlist fresh inside the lane; an artist mix is addressed by artist name (default: the
actor's top artist), and `window` applies to top tracks.
Library: favorite add(position?)/list/play(index)/remove(index)/clear(confirm), mix
save(name,replace,session?)/list/load(name)/delete(name). `session: true` saves a session mix:
songs already played this session (oldest first, each once), then the current song and queue,
dropping the oldest played songs to fit 100 tracks; the usual mix limits and owner rules apply. Existing `/favorite` becomes
global; library edits outside voice allowed with channel-aware source validation.
Device transfer: transfer(position: ms 0..86400000, paused: boolean, volume: 0-100,
repeat: off|track|queue) with root `tracks`: 1-100 public https song links, current
song first. Portal-only (never a slash command or public schema). It moves a
listener's browser session into their own voice channel: canAdd rules, no revision,
409 `session_active` if the server already has a current song or queue, and the
same resolve/join/restore path as `session resume`. The first link keeps
`position` only if it resolves; unavailable links are left out and reported.
Settings: volume(value), fairqueue(enabled), autoplay(mode:off|on|listening), djrole(role), reset; add musicchannel
subcommand with option channel, validating same-guild bot-readable/writable text
channel. Keep public command schemas in bootstrap updated. `back` restarts the
current track after its first three seconds (or when no earlier track exists);
otherwise it plays the previous session track and returns the current one to the
front of the queue.

Use expectedRevision for queue edits/skip/back/seek/replace/save-current operations;
UI should include the last snapshot revision. Ordinary play additions may omit
it. Stop keeps existing urgent/cancellation behavior. A stale write returns409.
Do not nest the same withGuildMutation lane twice or bypass maintenance leases.

Integration additions: `clear` removes only upcoming queue entries and leaves the
current song, position, pause and connection intact. It uses the normal same-voice
DJ guard, mutation lane, revision fence and successful queue activity recording.
`favorite/add` without options saves the current song; optional one-based
`position` saves that upcoming queue entry by a fresh server-side reference. Both
require a snapshot revision and visible source channels, allow library saves
outside voice, and never accept a browser track object. Expose both additions in
the bot's safe public command schemas and preserve slash-command parity.
`replay` and `session/resume|discard` also require a revision. Query length is
200 characters, matching the hardened public bot schema; seek timestamp format
and length must match that schema. Commands use a bounded 90-second upstream
deadline to cover public imports; uncertain completion refreshes state and must
never automatically retry a mutation.

Library selections must remain bound to what the user saw across devices,
guilds and permission changes. `favorite/play` and `favorite/remove` require
`expectedTrackId` from the selected favorite's public Track.id (24 lowercase hex).
`replay` requires `expectedHistoryId` from the selected Library.history entry
(bounded nonempty string, at most 40 characters). `mix/delete` requires
`expectedMixVersion` from the selected mix's version (32 lowercase hex), captured
when its confirmation opens. A mix version hashes its existing owner, ordered
references and savedAt; it needs no data migration. A newly received snapshot
revision cannot substitute for the version of older displayed library contents.
The API and bridge accept these fields only for their matching commands. The bot
compares them with freshly authorized server-side data before dispatch and again
at the durable transaction or enqueue boundary. Changed selections return 409;
refresh the library, allow a deliberate user retry and never replay the write.
References and authority still come entirely from the bot. Native numbered/name
slash commands keep their existing behavior.

Playlist imports: `favorite/import {link}` and `mix/import {name,link}` without
`expectedImportId` are a read-only preview. The response adds `preview`:
`{id,target,name,title,found,toAdd,duplicates,unmatched,overLimit,limit,notes,tracks}`
(`tracks` holds at most 100 `{title,author}`; `id` is null when nothing can be
added). Sending the same command and link with `expectedImportId: id` (32
lowercase hex) saves that preview once, rechecking membership, mix ownership or
Manage Server, and the favorite, mix and mix-count limits at the write. A preview
is bound to its listener, server, target and link, and expires after 10 minutes.

Errors: `{error:{code:string,message:string}}` with safe useful text. HTTP401
unauthenticated,403 forbidden/wrong voice/DJ/hidden channel,404 inaccessible
guild or missing resource,409 stale/changed session,400 invalid input,429 busy,
503 bridge/Discord/audio unavailable. Avoid arbitrary upstream errors/logs.

## Internal bot endpoints (bot bridge)

All require `Authorization: Bearer <PORTAL_BRIDGE_TOKEN>`. Header only. No
browser access or CORS. Portal sets the trusted session's actorId itself.

- GET `/v1/bootstrap?actorId=...` -> Bootstrap WITHOUT csrfToken (portal adds it).
- GET `/v1/guilds/:guildId?actorId=...` -> GuildSnapshot.
- GET `/v1/guilds/:guildId/configuration?actorId=...` -> Configuration (admin only).
- GET `/v1/guilds/:guildId/library?actorId=...` -> Library.
- GET `/v1/guilds/:guildId/search?actorId=...&query=...` -> search response.
- POST `/v1/guilds/:guildId/commands` body `{actorId,...validated command body}`.
- GET `/v1/guilds/:guildId/diagnostics?actorId=...` -> Diagnostics.
- GET `/v1/guilds/:guildId/activity?actorId=...` -> Activity.
- GET `/v1/guilds/:guildId/stats?actorId=...&window=...` -> Stats (history channel scope,
  including the guild's most recent 50 voice channels with plays).
- GET `/v1/guilds/:guildId/lyrics?actorId=...` -> LyricsResponse. The bot asks Lavalink's
  LavaLyrics `GET /v4/lyrics?track=<encoded>` for the visible current song (8 s bound).
- GET `/v1/guilds/:guildId/lyrics/:videoId?actorId=...` -> LyricsResponse. Membership only;
  the bot loads that YouTube video through Lavalink, then looks up its lyrics the same way.
- GET `/v1/guilds/:guildId/recap?actorId=...&window=...` -> Recap (history channel scope,
  like stats).
- POST `/v1/stats/requests/clear?actorId=...` -> `{ok:true,cleared:number}`. Requires a fresh
  verified identity; no guild grant is involved.
- POST `/v1/preferences/autoplay-taste/on|off?actorId=...` -> `{ok:true,enabled:boolean}`. Fresh
  verified identity, no guild grant. `/radio mytaste` is not accepted on the commands route.
- GET `/v1/guilds/:guildId/audio/:videoId?actorId=...` -> audio bytes by range (see the
  public route). The bot fetches each song once from Lavalink's `/vybatron/audio/{id}`
  (falling back to `/youtube/stream/{id}` itag 140, then 251), holds it in a 64 MiB
  in-memory LRU (40 MiB per track, two downloads at a time), streams it from the start
  while it arrives, and serves ranges from it once complete. Authority comes from the
  Gateway cache when it can vouch, else a fresh REST round.
- GET `/v1/guilds/:guildId/analysis/:videoId?actorId=...` -> SongAnalysis. Membership only
  (fresh policy, channel scope none, like the video lyrics route). The bot gets the song
  through the audio route's cache (no second download path), analyses `audio/ogg` only
  (404 `analysis_unavailable` otherwise, remembered for 10 minutes), one song at a time
  (429 `busy` while another runs), in a worker thread ended after each song, and keeps 24
  results in an in-memory LRU. A request waits up to 5 s, then answers `pending`.
- GET `/v1/users/:actorId/player` -> `{player, devices}` (Device without `connected`/`active`),
  an empty player for a listener without one. POST `/v1/users/:actorId/player` body `{op, ...}`
  (the public player operations except the device ones) and POST `/v1/users/:actorId/devices`
  body `{op: 'register'|'rename'|'forget'|'forgetSession', ...}` (`register {deviceId, name,
  kind, sessionRef}`, `forgetSession {sessionRef}`) -> `{player, devices[, dropped]}`. The actor
  in the path is the session's; identity only, plus fresh membership of any `guildId` in the body
  (the audio route's check). `sessionRef` is a hash the portal derives from the session key; it
  never leaves the store. Each change is one transaction in the library's write queue, in the
  listening-state store's `players` and `devices` tables (not mirrored into `library.json`;
  players and devices together are capped at 2 MiB, least recently updated players shed first,
  devices at 2,000 overall, least recently seen forgotten first, and players are deleted after
  90 days unused). Forgetting or pruning a device releases the player it played.
  Sign-out cleanup the bot can't take yet is retried by the portal with backoff. Refusals answer `{error, player?, devices?}` with the codes above; a conflict carries the complete snapshot.
- GET `/health` (still authenticated) -> `{ready:boolean}`.
- GET `/v1/changes?instance=...&after=...` -> `{instanceId:string,sequence:number,reset:boolean,guildIds:string[],sequences:number[]}`.
  Private wake-up long poll (held up to 20 s). Carries guild IDs only, never
  actor, track or permission data; consumers must perform their own fresh
  authorized read for each woken stream. An unknown instance or expired cursor
  returns `reset:true`. `sequences[i]` is the newest entry for `guildIds[i]`.
  While the feed has a consumer, snapshot reads and successful commands answer
  with `X-Change-Cursor: <instanceId>:<sequence>`: a snapshot read reflects every
  entry up to that sequence (taken before its authorization), and a command's
  value is the entry it published. See [instant controls](portal-instant-controls.md).
- GET `/v1/latency?actorId=...` -> private maintainer-only direct-control timings:
  `{retentionSeconds:900,capacity:32,records:[{at:number,command:pause|resume|seek|filter|volume,success:boolean,totalMs:number,readyForMutationMs:number|null,authorization:{count:number,ms:number},playback:{count:number,ms:number},presentation:{count:number,ms:number}}]}`.
  Requires fresh verified maintainer identity in addition to bridge authentication.
  No portal/browser route exposes it. No actor, guild, track, input, permission
  or error data is retained. Records older than 15 minutes are excluded and pruned
  on observation or a new tracked command; bridge shutdown clears memory immediately.
  Ready-for-mutation measures native playback-operation entry after guards,
  not audible delivery. Seek/filter spans include their wrapper validation or
  serialization and may finish without an audio write.
  Web direct controls schedule bounded cosmetics: awaited presentation count/ms
  are zero, and later background writer settlement is excluded from this DTO.
  Each record also contains `authority:{native:Phase,finalDisclosure:Phase}`,
  where `Phase` is `{count:number,wallMs:number,inputs:{user:Input,
  application:Input,guild:Input,actorMember:Input,botMember:Input,channels:Input}}`
  and `Input` is `{count:number,waitMs:number,maxMs:number,timeouts:number}`.
  These are fixed internal labels and numeric caller timings only. Phase count
  counts fresh policy contexts; phase wall time includes their dependency rounds.
  Input waits include overlapping shared-read and channel-pool wait time, so their
  sum is not phase wall time and does not identify SDK/network/bucket causes.
  Timeouts count the bounded caller deadline while its underlying input remains
  unsettled; actual admission remains held until that underlying work settles.
  A failed phase freezes pending sibling fields, which may have count but zero
  wait time. Publication, phase exit, expiry and shutdown exclude late updates.
  Active traces older than 15 minutes cannot publish a new completed record.
  The browser predicts playback controls immediately and reconciles them with
  these authorized results; see [instant controls](portal-instant-controls.md).
  Non-playback actions remain locked until actual settlement.

Same response/error shapes. HTTP bridge failures are contained and never fatal
to audio. A private loopback test harness/fixtures must prove capabilities,
privacy and conflict behavior without live audio mutations. Tests exercise the
actual adapter, migration and HTTP service, not only matching mocks.
