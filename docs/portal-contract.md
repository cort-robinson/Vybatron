# Portal v1 integration contract

This is the shared contract for three parallel implementation tasks. Implement
this shape exactly. Root coordinates changes; do not silently invent incompatible
paths/names. JSON uses camelCase. Dates are epoch milliseconds. Track positions
and command indices are one-based. Durations/positions are milliseconds.

## Ownership and deployment boundary

- Bot task: `src/portal/**`, necessary existing bot modules and bot tests. Export
  `startPortalBridge(client, options)` with close/dispose handling. Optional bridge
  defaults disabled unless `PORTAL_BRIDGE_TOKEN` is set. Bind
  `PORTAL_BRIDGE_HOST` (default loopback; Compose uses 0.0.0.0) and
  `PORTAL_BRIDGE_PORT` (default 3010). Never publish bridge host ports.
- API task: `portal/server/**` only, including its package/test files. Node HTTP
  service listens on `PORTAL_HOST`/`PORTAL_PORT` (default 3001); serves build from
  `PORTAL_WEB_DIST` (default sibling `../web/dist`). Uses `PORTAL_BOT_URL` (private
  bridge origin), `PORTAL_BRIDGE_TOKEN`, `PORTAL_ORIGIN`, `DISCORD_CLIENT_ID`,
  `DISCORD_CLIENT_SECRET`, `PORTAL_SESSION_SECRET`, `PORTAL_DATA_DIR`.
- UI task: `portal/web/**`, `portal/PRODUCT.md`, `portal/DESIGN.md`, scoped surface
  briefs and `portal/design-qa.md`. Root creates assets under web/public/assets.
  Vite proxy `/api` and `/auth` to localhost:3001; configurable VITE_API_PROXY.
- Root: contract/plan, assets coordination, Docker/Compose/CI/env/runbook/release.
  No agent commits or mutates live infrastructure during its implementation task.

Bot bridges trust only their constant-time validated secret and a session-derived
actorId. Bot rechecks Discord member/owner/Manage Server/DJ/channel/voice state.
Portal NEVER accepts actorId/roles/voice/maintainer from browser data. Portal
music storage is not shared with bot music JSON. Auth cookies/tokens remain server-side.

## JSON types

`Viewer = { id, username, displayName, avatarUrl: string|null, maintainer: boolean }`

`Guild = { id, name, iconUrl: string|null, admin: boolean }`

`Track = { id: string, title: string, author: string, uri: string|null,
  source: string, durationMs: number, artworkUrl: string|null, isStream: boolean,
  requestedBy: {id, displayName, avatarUrl: string|null}|null }`

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
  guild: Guild, revision: string,
  session: {
    status: 'idle'|'playing'|'paused'|'recovering'|'unavailable',
    voiceChannel: {id,name}|null, textChannel: {id,name}|null,
    current: Track|null, queue: Track[], positionMs: number, durationMs: number,
    volume: number, filter: string, repeat: 'off'|'track'|'queue',
    radio: boolean, fairQueue: boolean,
    listeners: {id,displayName,avatarUrl:string|null}[],
    canAdd: boolean, canControl: boolean, canVote: boolean, reason: string|null
  },
  savedSession: {exists:boolean, savedAt:number|null, positionMs:number,
    paused:boolean, trackCount:number, voiceChannel:{id,name}|null,
    canResume:boolean},
  settings: {volume:number,fairQueue:boolean,djRoleId:string|null,
    musicTextChannelId:string|null}|null,
  channels: {id,name,type:'voice'|'text'}[], roles:{id,name}[]
}`

If session channel is not visible, expose an idle/empty projection and a safe
reason; do not reveal restricted channel ids/name/tracks/listeners/checkpoint.
Settings/channels/roles include only authorized fields; settings null for basic
members. Snapshot channels are the relevant, freshly verified session channels;
the complete settings catalog is discovered separately on demand. Revision changes on queue/current identity and relevant state changes,
not continuously on time interpolation. Compare revision INSIDE the mutation
lane for queue conflicts; web queue edits must not race a Discord edit/track end.

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

## Public browser endpoints (portal API task)

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
  expectedTrackId?:string,expectedHistoryId?:string,expectedMixVersion?:string}`.
No actor or authority fields accepted. Strict whitelist command/options/schema.
Route through existing trusted command implementations/guards/lane semantics.
Response `{ok:true,message:string,snapshot:GuildSnapshot}`. Only safe text from
the command reply; never raw Discord interaction/token objects or embeds with secrets.

Core playback command names and options: play/playnext(query), pause/resume,
seek(timestamp), skip/skipto(position), stop, clear, remove(position), move(from,to),
shuffle, loop(mode:off|track|queue), volume(level), filter(preset), voteskip,
radio subcommand on/off, replay(index), session resume/discard.
Library: favorite add(position?)/list/play(index)/remove(index)/clear(confirm), mix
save(name,replace)/list/load(name)/delete(name). Existing `/favorite` becomes
global; library edits outside voice allowed with channel-aware source validation.
Settings: volume(value), fairqueue(enabled), djrole(role), reset; add musicchannel
subcommand with option channel, validating same-guild bot-readable/writable text
channel. Keep public command schemas in bootstrap updated.

Use expectedRevision for queue edits/skip/seek/replace/save-current operations;
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

Errors: `{error:{code:string,message:string}}` with safe useful text. HTTP401
unauthenticated,403 forbidden/wrong voice/DJ/hidden channel,404 inaccessible
guild or missing resource,409 stale/changed session,400 invalid input,429 busy,
503 bridge/Discord/audio unavailable. Avoid arbitrary upstream errors/logs.

## Internal bot endpoints (bot task)

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
- GET `/health` (still authenticated) -> `{ready:boolean}`.
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

Same response/error shapes. HTTP bridge failures are contained and never fatal
to audio. A private loopback test harness/fixtures must prove capabilities,
privacy and conflict behavior without live audio mutations. Tests exercise the
actual adapter, migration and HTTP service, not only matching mocks.
