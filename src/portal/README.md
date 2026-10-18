# Bot portal bridge implementation notes

The binding public/internal DTO and endpoint contract is
[`docs/portal-contract.md`](../../docs/portal-contract.md). This directory exports
`startPortalBridge(client, options)` from `index.js`. The returned object has
`server`, `ready`, `close()` and `dispose()`; disabled startup returns the same
lifecycle interface without opening a socket.

Private `/v1/latency` records the last 32 Pause/Resume/Seek/Filter/Volume command
stage timings with a 15-minute read-time TTL, without actor/guild/track/input/error data.
Expiry is pruned on observation or a new tracked command; shutdown clears memory.
It requires the bridge secret and freshly verified maintainer identity; guild
administration alone does not grant access. The portal does not proxy it. Numeric
authorization, playback API and awaited presentation durations distinguish
command delays; ready-for-mutation marks native operation entry, not audible delivery.
Seek/filter spans include wrapper validation or serialization and may complete
without an audio write.
Instrumentation is observational and preserves operation results/errors.

The bot starts the optional bridge after its single MusicLibrary and command
catalog are initialized. `PORTAL_BRIDGE_TOKEN` enables it; host defaults to
`127.0.0.1`, port to `3010`. Tokens need 32-512 non-whitespace bytes. Optional
`PORTAL_OPERATOR_IDS` is a comma-separated, securely provisioned Discord account
allowlist. Otherwise the freshly verified bot application user owner or team
owner is maintainer. That identity grants settings/diagnostics access, never
membership, channel visibility, voice membership or a playback DJ override.

Requests require a constant-time checked bearer token, reject browser Origin
headers, and have bounded headers, URLs, body size, concurrency, socket count,
request rate, source deadlines and response size. Defaults: 16 ordinary active
requests plus two reserved Stop slots, 48 sockets, 600 ordinary requests/minute
plus 30 reserved Stop requests/minute, 16 KiB JSON commands, 4 MiB responses.
Discord REST reads have individual five-second deadlines. Arbitrary upstream errors are
replaced with safe error categories; bridge bind/request failures do not become
fatal bot/audio errors. Shutdown closes the bridge before music data and Discord.

Every protected read and command refreshes Discord identity, application-owner
verification, installed guild ownership, guild membership, channels, role
definitions and the bot member. Voice state comes from the ready Discord
gateway's trusted live voice-state cache. Both the session voice channel and
controller text channel must be visible to reveal live/saved session data. History
is independently filtered by its original voice channel. Basic members never
receive settings, channels, roles, diagnostics or actor activity.

Overlapping protected reads coalesce the same in-flight Discord REST request;
completed profiles, ownership and permission results are never cached. Commands
always start separate fresh reads, including their post-lookup checks. Underlying
reads retain their admission slot after an individual caller times out, until
Discord settles, preventing stalled reads multiplying on every poll. The pool
holds at most 128 underlying reads plus eight reserved urgent slots, enough for
one complete Stop authorization round; a round is admitted whole or refused.
Four concurrent same-account snapshots share each relevant individual channel and
authority input while they overlap; spaced polls or different actors still fetch
their own current account/member state. User, application owner, raw guild/role
inventory, actor member and bot member are independent routes and start
together as one round. When Gateway already places the actor in one of the
guild's voice channels, the session channel reads join that round; the channel
set is recomputed after binding and any newly referenced channel is fetched
fresh. A failed round submits no further channel batches. All inputs settle and
gateway readiness is checked again before permissions are evaluated. No
completed input or grant is reused.
Fresh role inventories evict deleted roles from discord.js's cache before its
member/channel permission getters run. Permission inputs are detached as each
fresh response settles, before other member/role/bot/channel awaits: guild owner,
actor and bot role IDs, complete role definitions and channel overwrites. The
stage-local guild/member/role/channel views retain discord.js's actual permission
getters and overwrite precedence. Delayed shared-cache patches cannot change
that stage's authority; every following stage still fetches again. Native
joinable/speakable and bot writability use the same fetched bot member, including
its timeout. The native settings member read returns that stage's bot view;
native rechecks and the durable settings transaction each refresh all inputs.
An outside-guild maintainer receives
settings and diagnostics, without a bot-permission channel-list bypass.

The additive [channel-read contract](../../docs/portal-channel-read-contract.md)
separates complete discovery from authorization. `session` (the default) reads
only current player voice/text, actor voice, saved voice/text and configured
music text IDs. `history` adds up to 100 persisted history source IDs and the 50 most recent
play-statistics voice channels for library, stats, recap, history, replay and top. Each musicchannel settings stage also includes its validated
new target ID. `none` is used only by the directory and read-only admin activity
or diagnostics; it never projects music. Only explicit admin
`GET /v1/guilds/:guildId/configuration?actorId=...` performs a fresh list read,
after fresh admin authorization. It returns `{guildId,channels,roles}` with the
same visible text/voice filter and 500-channel/250-role projection bounds.
Snapshot channels are the relevant verified subset, not a discovery catalog.

Individual reads use `guild.channels.fetch(id, {force:true})`, immediately
detaching overwrite objects and permission bitfields in `authority.js`.
Version 14's `cache:false`
can return an existing unpatched object even after a REST response, so it cannot
provide fresh permission data. The normal forced refresh is necessary; no later
request or command stage authorizes from its completed cache result. Native
handlers receive a request-local guild/member view using only that stage's
verified channels, including fresh bot join/speak access. Deleted, inaccessible,
foreign and mismatched channels are absent and fail closed.

Ordinary individual channel reads share a global four-read pool and are
submitted in batches of at most four. Four permits the common four-distinct-ID
case to complete in one channel round; two would require another network wait.
Stop has a separate two-read pool and submits at most two channel reads at once,
so its full round fits the eight reserved admissions even when 128 ordinary
reads are stalled. Timed-out reads retain their network
and admission slots until actual settlement. These pools do not preempt Discord's
own REST FIFO/global limits. No Discord rate bucket is hardcoded or bypassed.

Queue, now-playing, history, replay and readonly saved-session replies use neutral
acknowledgments with the final fresh snapshot. Other protected music reply text
is suppressed when final authority hides its session/source. Every mix action's
captured reply also requires final guild membership, even in an idle guild whose
verified maintainer retains configuration access. Private favorites remain scoped
to the actor. This prevents earlier
captured embeds from disclosing names after current or history-source revocation;
no mutation is rerun. Public help and visible-session native errors retain their
useful text. Application ownership is still verified fresh at every required
stage, with no new owner/operator lifetime or completed identity cache.

Commands reuse the existing handlers and exactly one `guardedMutation` lane.
Revision comparison runs inside that lane after a fresh access check. Slow
lookups recheck membership/voice/DJ/channel visibility before writes. Track-end
events, queue/current identity changes, relevant player/settings/mix/history
changes and explicit seeks invalidate revisions; interpolated time and periodic
checkpoint timestamps do not. Stop ignores an old valid revision and preserves
the urgent cancellation/player-fence path. Ordinary additions remain serialized.
Portal option aliases are `skipto(position)` -> slash `index`, and `replay(index)`
-> slash `position`. Replay resolves a fresh public reference from visible
persisted history and verifies the same visible history entry after resolution,
rather than trusting a browser track or encoded audio. `clear` removes only the
upcoming queue, preserving current track, pause, position and voice connection;
it retains normal same-voice/DJ, lane, revision and queue-activity behavior.

Favorites and mix saves may run outside voice when the source channels are
visible. `favorite add` optionally accepts a one-based upcoming `position`; no
option still means current song. Both use fresh server references and the same
snapshot revision. Slash/web saves recheck both original channels and the source
identity inside the durable library transaction. Slash queue/history/current and
saved-session previews enforce the same channel visibility. Discord component favorite buttons retain their existing voice and
track binding. Starting a web session requires a configured bot-readable and
writable guild text channel; `/settings musicchannel` has the same validation.
An active session always keeps its existing controller. Saved restoration uses
the original voice/text channel, position and pause in the first hardened play
request. Stop explicitly discards its checkpoint.

The sole MusicLibrary writer now stores version 2: global account favorites,
preserved favorite overflow, and guild settings/mixes/checkpoints/history/activity.
Before migrating v1 it writes and syncs an exact-byte private
`library.json.v1.<uuid>.bak`, then atomically replaces the document. Duplicate
public references merge by canonical URI, preserving the first reference and
all distinct recordings. The first 1,000 are active; excess migrated references
stay on disk and move back to the active shelf as removals open space. Explicit
confirmed Clear removes active and overflow favorites. Reopening v2 does not
remigrate. Backup/write/rename failures fail safely with the original file intact.
Rollback to v1 requires restoring the exact backup while the bot is stopped;
the old bot cannot read v2, and new v2 changes must be preserved separately.

History stores only public references and original voice channel IDs, keeps 100
entries and filters 30-day expiry at reads/startup/writes. Successful queue and
settings edits record bounded actor identity/action text for 24 hours (200 items),
including Discord command/component mutations; private favorites are excluded.
History, activity and checkpoints live in `listening-state.sqlite` (ADR-0009);
`library.json` keeps a copy written at shutdown for older releases.
An hourly cleanup removes expired durable records even while idle. Disk failures
in history/activity recording do not interrupt Discord audio. No second player,
audio decoder, source writer or music-library instance was introduced.

## Integration items for root

- Keep UI/API revisions on clear, play-next, replay, session resume/discard and
  queue/seek/source-save edits. Replay uses control/DJ capability. Mix/favorite
  source-save controls allow visible sessions outside voice; queued favorites
  send the one-based position and never a browser track object.
- Keep command timeout aligned with the 90-second bridge transport deadline
  (imports can resolve for 68/60 seconds). Uncertain completion refreshes state
  and never automatically retries a mutation.
- Match the hardened 200-character query limit, slash seek format/length and
  public favorite bounds (1-1000 active entries, positions 1-500, pages 1-100).
- Add `PORTAL_OPERATOR_IDS` to root's secure env inventory only if the operator
  allowlist is needed. Verified application ownership works without it.
- Keep the bridge port private. Back up the bot volume before the v2 data
  migration; preserve the v1 backup and the prior audio stack for rollback.

Tests use real loopback HTTP, actual command handlers/guards/lanes, Discord
permission bitfields, and real temporary MusicLibrary files. Discord/Lavalink
network boundaries are deterministic fakes; no live VPS, voice or Discord writes
occur. Targeted evidence is in `tests/portal.test.js`, `portal-library.test.js` and
`portal-fixtures.js`; existing bot suites cover native hardened playback behavior.

The independent review adds actual HTTP and core guard regression evidence in
`tests/portal-guards.test.js`, including source visibility changes during Replay,
deleted role grants using real Discord structures, global-library transaction
source binding, overflow access and reserved Stop admission. Automated/source
checks are separate from the root-owned live pilot/audio, secure provisioning
and deployment release gates.

Web Pause/Resume/Seek/Filter/Volume, and Loop/Shuffle/Remove/Move/Clear/Radio-on, await the actual playback API and schedule owned, bounded cosmetic writers. Their timing records report zero awaited presentation spans; native Pause/Resume retain awaited controller and voice-status spans. Background writer settlement is excluded from command timing and never represents audible delivery. Terminal Stop and idle paths retire presentation ownership immediately and do not await cosmetic REST settlement before destroying playback.

Every handler whose first await is the native `requireControl` guard (those controls plus Skip, Skip-to, Voteskip and Stop) takes its only pre-write authority at that in-lane guard, followed by a fresh final disclosure.

`changes.js` serves the private `GET /v1/changes` wake-up long poll for the portal API: guild IDs and a cursor only, driven by Lavalink player events, a 250 ms local revision scan while a consumer is active, and Gateway voice/channel/role/guild updates. See [instant controls](../../docs/portal-instant-controls.md).
