# Separate channel discovery from fresh authorization

The live 874b46b pilot retains the synchronization recovery fix, but root's
read-only probe still fails the third queue command with bridge503. Actual
Discord GET responses identify a server-wide channel-list bucket of ten reads
per sixty seconds. Individual channel GETs report much greater capacity for
this bot. Never hardcode those measured limits: Discord owns their buckets.

This is a routine implementation correction within the approved portal scope.
The existing fresh membership, role, owner, same-voice, DJ and channel-view
checks remain mandatory. No completed permission result or channel-overwrite
authorization may be reused across requests or command mutation boundaries.
Each stage must detach its freshly fetched guild owner, actor/bot membership role
IDs and role permission definitions from mutable Discord caches, as well as its
channel overwrites. Policy projections and native command views must evaluate
those same stage-local inputs. A delayed Gateway/cache patch cannot restore a
revoked grant during the remaining awaits. Captured guild-library reply text must
also respect final membership, even when no active session exists.

## Bot scope and channel reads

`createPortalPolicy().guild` gains a server-selected channel scope. Default
`session` fetches fresh individual channels by ID for the current player voice
and text channel, current actor voice channel, saved session voice/text channels
and configured music text channel. De-duplicate those IDs. Gateway/cache state
supplies IDs only; it cannot supply permissions or overwrite data for protected
projection or mutation. Check the returned channel belongs to the target guild.
Unknown/deleted channels remain absent and fail closed. A gateway drop also fails
closed before evaluating the newly read data.

`history` scope adds the latest bounded history's voice-channel IDs to the
session scope. `/library` and history/replay commands use this scope so private
history stays filtered using current channel authorization. Settings musicchannel
commands add their validated target ID at every fresh check; do not treat the
client-supplied ID as evidence of visibility or bot writability.

`none` scope is allowed only for installed-guild directory/bootstrap and read-only
admin infrastructure/activity projections that expose no music/channel data.
The member, role and verified owner checks still run. No music operation uses it.

`configuration` scope alone discovers the complete channel inventory with a
fresh guild-channel-list request. It is used by the explicit admin endpoint,
not live snapshots, ordinary playback, search, library or command reconciliation.
Admin status must be checked before allowing channel discovery. Apply the same
visible text/voice filtering and role bounds as the existing snapshot projection.

Individual reads are bounded, pending-only shared for ordinary readers, and
strictly fresh for command stages. Stop retains its two reserved authority slots
and at most two concurrent channel reads. Bound ordinary per-channel work too;
do not launch hundreds of reads at once or weaken existing admission/deadline
limits. Any missing required fresh state prevents that operation.

Snapshot `channels` now contains only the relevant individually verified channels
(still admin-only), rather than promising a complete configuration catalog.
Existing session fields, settings, roles, revisions and selection fences are
retained. No second music store, stream or browser audio path is introduced.

## Additive endpoint and DTO

Private `GET /v1/guilds/:guildId/configuration?actorId=...` maps to authenticated
`GET /api/guilds/:guildId/configuration`. Actor identity remains session-derived.
Both use the normal protected-read transport, bounds, errors and no-store policy.

`Configuration = { guildId: string, channels: {id,name,type:'voice'|'text'}[],
roles: {id,name}[] }`

The bot performs fresh admin authorization, returns only currently visible
channels, and preserves the existing role/channel bounds. Basic members are
denied. A verified nonmember maintainer may receive an empty channel catalog
and continue configuring by explicit Discord ID, under fresh bot-writability
checks; this does not grant playback rights.

## Browser behavior

The Server settings view fetches configuration once when opened for an admin
and when switching guilds or deliberately refreshing options. It must not fetch
again on every SSE snapshot. Fence responses by abort signal and guild/admin
state. Clear on hard401/403/404 or revoked admin status. Retain typed input and
show a bounded loading/error/retry state; a discovery failure must not disable
unrelated playback/settings controls. Configuration choices never authorize a
write: the existing fresh session gate and server-side checks do that.

Use existing Server component styling. No redesign or new visual direction is
needed. Do not automatically replay any command when discovery or connection
recovers. Normal mobile/desktop controls continue using the authoritative live
session stream and its existing recovery/freshness policy.

## Ownership and verification

Bot task owns `src/portal/**` and bot portal tests/fixtures only. UI task owns
Server settings component and its focused browser tests only. Root owns API
server route/tests, web `api.ts` and `types.ts`, this contract, integration, CI,
builds, deployment and live probes. No children commit or perform live operations.

Regressions must exercise list-bucket exhaustion without affecting normal state
or commands, stale/deleted/foreign individual channel data, history privacy,
configuration admin/visibility fences, selected musicchannel mutation, concurrent
read bounds and Stop reservations. Browser verification must prove one discovery
read despite repeated fresh SSE snapshots, no cross-guild/privilege response
leak, retained input, and no automatic write replay. Run relevant existing suites
and exact-source CI before the next guarded deployment and owner acceptance.
