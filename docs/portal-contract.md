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

`Viewer = { id, username, displayName, avatarUrl: string|null, maintainer: boolean }`

`Guild = { id, name, iconUrl: string|null, admin: boolean }`

`Track = { id: string, title: string, author: string, uri: string|null,
  source: string, durationMs: number, artworkUrl: string|null, isStream: boolean,
  requestedBy: {id, displayName, avatarUrl: string|null}|null, suggested?: boolean }`

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
- GET `/auth/discord/callback`: verified Discord identity, establish seven-day
  device session; redirect `/`. No token/session ids in URLs/logs.
- POST `/auth/logout`: same-origin + CSRF checked, destroy this device session.
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
- GET `/api/guilds/:guildId/recap?window=7d|30d|90d|365d` -> Recap. Only `window` is
  accepted; omitted means `30d`.
- POST `/api/stats/requests/clear` -> `{ok:true,cleared:number}`. Same-origin + CSRF, no body.
  Anonymizes the signed-in listener's recorded requests in every server; server totals remain.
- GET `/api/guilds/:guildId/audio/:videoId` (11-character YouTube id): this device's
  player. Audio only (`audio/ogg` Opus from the vybatron-audio Lavalink plugin; the
  YouTube stream route's `audio/mp4` or `audio/webm` as a fallback), served with
  `Accept-Ranges: bytes`. A request from the start of a song still arriving streams at
  once without a length; other ranges wait for the whole song, then a single
  `Range: bytes=a-b` is honored (206) or rejected (416). Membership only, like search.
  Only audio bodies up to 40 MiB pass through; errors keep the sanitized JSON shape. A
  separate four-stream pool keeps slow phones off command slots.
- GET `/api/guilds/:guildId/events`: credentialed same-origin SSE. `event:snapshot`
  carries GuildSnapshot. Heartbeat comments. Permission/session loss closes
  stream; state-unavailable must not replay writes. Bound connections, polling,
  buffers, requests and payloads; fresh policy before protected data/mutations.

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
- GET `/v1/guilds/:guildId/recap?actorId=...&window=...` -> Recap (history channel scope,
  like stats).
- POST `/v1/stats/requests/clear?actorId=...` -> `{ok:true,cleared:number}`. Requires a fresh
  verified identity; no guild grant is involved.
- GET `/v1/guilds/:guildId/audio/:videoId?actorId=...` -> audio bytes by range (see the
  public route). The bot fetches each song once from Lavalink's `/vybatron/audio/{id}`
  (falling back to `/youtube/stream/{id}` itag 140, then 251), holds it in a 64 MiB
  in-memory LRU (40 MiB per track, two downloads at a time), streams it from the start
  while it arrives, and serves ranges from it once complete. Authority comes from the
  Gateway cache when it can vouch, else a fresh REST round.
- GET `/health` (still authenticated) -> `{ready:boolean}`.
- GET `/v1/changes?instance=...&after=...` -> `{instanceId:string,sequence:number,reset:boolean,guildIds:string[]}`.
  Private wake-up long poll (held up to 20 s). Carries guild IDs only, never
  actor, track or permission data; consumers must perform their own fresh
  authorized read for each woken stream. An unknown instance or expired cursor
  returns `reset:true`. See [instant controls](portal-instant-controls.md).
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
