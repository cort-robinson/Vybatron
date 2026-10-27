# ADR-0011: Portal authorization from Gateway state, with briefly remembered identity

- Status: Accepted
- Date: 2026-10-27

## Context

The portal checks Discord authority on every request: who the actor is, whether they are the
bot's maintainer, the guild owner and role definitions, the actor's and bot's member records,
and the relevant channels' overwrites. Until now every protected read (bootstrap, snapshot,
library, stats, recap, each live-stream read) and every command's final disclosure fetched all
of that again from Discord REST, and nothing successful was kept (`src/portal/README.md`,
`docs/portal-channel-read-contract.md`). Each read cost a full round of six or more REST calls
(about 300-570 ms measured on the deployed bot). The final disclosure ran after the write had
already happened and held the reply, and the browser's next queued control waits for that
reply's revision. Bootstrap took one full round per installed guild, four guilds at a time.

`docs/portal-instant-controls.md` already moved the pre-write authority of audible controls and
song additions to the Gateway cache. With the privileged GuildMembers intent (required at
login), Gateway push events keep every authorization input current: guild owner
(`guildUpdate`), role definitions (`roleCreate`/`roleUpdate`/`roleDelete`), the actor's roles and
timeout (`guildMemberUpdate`), membership (`guildMemberAdd`/`guildMemberRemove`), channel
overwrites (`channelCreate`/`channelUpdate`/`channelDelete`), voice state (`voiceStateUpdate`)
and the bot's own installation (`guildCreate`/`guildDelete`). discord.js applies them to its
cache before emitting them. The REST round re-read state the bot already held.

Two inputs have no Gateway event: the actor's account (`users.fetch`, which proves the account
exists and is not a bot) and the bot application's owner (`application.fetch`, which decides
maintainer status).

## Decision

**1. Protected reads and the final disclosure use Gateway state when it can vouch.**
`policy.guild` gains a `gateway` option, on by default for protected (non-`fresh`) reads.
`gatewayView` builds the same detached, request-local authority view a REST round builds, in one
synchronous step from the cache, so no Gateway patch can land halfway through an evaluation. The
same projections and checks then run against it: membership, channel visibility for live and
saved sessions and for each history source, admin and maintainer scope. It covers the `session`,
`history` and `none` channel scopes. A channel absent from the cache is absent from the view,
exactly as a deleted channel is absent from a REST read; the Guilds intent caches every guild
channel, whatever the bot can see.

The cache cannot vouch, and the request takes the REST round exactly as before, when the
members intent is off, the guild is unavailable, its shard is not Ready (missed events replay on
resume; a new session re-sends every guild), or the actor, the bot member or the @everyone role
is missing from the cache. A kicked member is removed from the cache, so their next read takes
the REST round and Discord answers that they are not a member. A guild the bot left is gone from
`client.guilds.cache` and answers 404 before any read.

The final disclosure of every command (`commands.js`, `finalDisclosure`) uses Gateway state when
it can vouch, otherwise a **fresh** REST round as before. It decides only what the reply may show;
the write already happened under its own authority.

**2. Identity answers are remembered briefly.** A validated actor account is remembered for 30
seconds per actor (at most 1,000 actors) and the application owner for five minutes. Only a
success is kept: a failed read, a missing account, a mismatched ID, a bot account or a missing
owner is never remembered. `userUpdate` forgets that actor, and a read that started before an
invalidation is not remembered. Closing the bridge forgets everything.

**3. What stays fresh.** `fresh: true` never reads the remembered identity or Gateway state
unless the caller also asks for `gateway`. These stay fully fresh REST, unchanged: every
pre-write stage of Stop, queue edits (shuffle, remove, move, clear, loop, radio, voteskip,
replay), settings, library and mix actions, session restore and discard (including their
post-lookup and transaction rechecks); the `configuration` scope (complete channel discovery,
after REST admin checks); the private `/v1/latency` maintainer check; and clearing request
stats. Audible controls and additions keep the Gateway pre-write authority they already had,
which grants no maintainer access.

**4. Bootstrap authorizes guilds together.** Guilds the Gateway can vouch for answer at once.
The rest run their REST rounds concurrently, up to 16 guilds (48 reads, within the 128 ordinary
read admissions) instead of serial waves of four. Results keep the installed guild order, a
404 omits a guild, and any other failure stops new rounds and fails the bootstrap, as before.

### Revocation latency

| Change | Takes effect for reads and replies |
| --- | --- |
| Role removed or changed, timeout, channel overwrite, voice move, guild owner change | when its Gateway event arrives, normally well under a second |
| Kicked or left the server | next read: the member leaves the cache, then REST confirms |
| Bot removed from the server | next read (404) |
| Shard reconnecting or resuming | REST rounds until the shard is Ready again |
| Account deleted or became unusable | within 30 seconds, or the next fresh stage |
| Bot application ownership transferred | within five minutes, or the next fresh stage (settings writes, the latency view) |

A REST round was never instant either: its result was used until the request finished, up to
its five-second deadline. Pre-write authority for anything a revocation should stop
immediately (settings, library, Stop, queue edits) still reads Discord fresh.

## Consequences

- With 35 ms injected per Discord route, an audible control's final disclosure drops from 7
  REST reads (about 135 ms) to none once identity is remembered; a snapshot, library, stats or
  recap read from 7 or more to none; bootstrap with 12 uncached guilds from three serial guild
  rounds to one (`tests/portal-authorization-cache.test.js`).
- Discord rate-limit budget is left for the REST rounds that remain.
- A maintainer's admin view on reads depends on the remembered owner for up to five minutes.
- Correctness of reads now depends on discord.js applying Gateway events to its cache. The same
  dependency was already accepted for audible controls; a cache that cannot be trusted falls
  back to REST rather than guessing.
- This supersedes the "Gateway/cache state supplies IDs only" and "no completed profile or
  ownership result is cached" statements in `docs/portal-channel-read-contract.md` and
  `src/portal/README.md` for protected reads and final disclosure. Pre-write stages keep them.
