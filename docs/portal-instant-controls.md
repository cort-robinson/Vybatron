# Instant portal controls

Goal: the web portal should feel like a native music player, not a remote
control that waits on Discord. Previously a Pause took 1.5-5 s to confirm. Most
of that was Discord authorization, while the Lavalink write itself took
16-39 ms. During the wait every control was locked behind "Waiting for
confirmation".

## Where the time went

| Stage | Before | After |
| --- | --- | --- |
| Authorization round (identity, raw guild/roles, actor, bot, channels) | 4 sequential Discord REST waves | 1 round when Gateway shows the actor in voice (Stop included), otherwise 2 |
| Authorizations per queue/transport command (skip, skipto, loop, shuffle, remove, move, clear, radio, voteskip, stop) | 4 (admission, lane preflight, native guard, final disclosure) | 2 (native guard, final disclosure) |
| Awaited controller message edit for loop/shuffle/remove/move/clear/radio-on | inside the web reply | background writer (native slash commands unchanged) |
| Discord-side changes (slash/button, track end, voice join) reaching the portal | next 3 s poll, then a fresh read | bot change feed wakes same-guild streams immediately |
| Snapshot polling per open stream | every 3 s | every 10 s while the feed is healthy (3 s fallback) |
| Player on screen after a click | after the full round trip | immediately (optimistic), reconciled with the bot reply |

Less polling also frees Discord rate-limit budget for command authorization,
which accounted for the 2-5 s outliers.

## Server

- `src/portal/policy.js`: user, application owner, `GET /guilds/:id`, actor
  member and bot member start together, and for an actor Gateway already places
  in voice the session channels join that round. This extends `669962a`, which
  overlapped everything after identity for ordinary reads only. The channel set
  is recomputed after binding; a failed round submits no further channel
  batches. Every input is still a forced fresh read detached inside its read, no
  grant is derived until all settle, and nothing is cached. A round is admitted
  whole or refused. The urgent reserve grew from 2 to 8 reads so a full Stop
  round fits while 128 ordinary reads are stalled.
- `src/portal/commands.js`: every handler whose first await is the native
  `requireControl` guard skips the earlier admission and preflight rounds; that
  guard takes fresh authority inside the mutation lane. Final protected
  disclosure is unchanged.
- `src/portal/changes.js` + bridge `GET /v1/changes?instance=&after=`: a
  bearer-authenticated long poll that returns only `{instanceId, sequence,
  reset, guildIds}`. Lavalink player events and a 250 ms local revision scan
  (queue edits, volume, loop and filters have no event) detect changes, as do
  Gateway voice joins/moves, channel, role and guild updates, and member role,
  timeout and removal events. The scan runs
  only while a consumer polled within the last minute.
- `portal/server`: one follower long-polls the feed on its own socket, outside
  the protected request pool. Each wake makes the stream do its own fresh
  authorized read. Snapshots are never shared between actors. A reset, a new
  bot instance or a recovered feed wakes every stream. When the feed fails,
  streams fall back to 3 s polling.

## Live updates

| Per open stream | Before | After |
| --- | --- | --- |
| Bridge reads (each a fresh Discord authorization round) after one portal command | 1-2 (command wake, then the feed wake) | 1 |
| Idle traffic, 500-track queue, 10 s polls | a 170 KB snapshot per poll, about 61 MB an hour | a 160-byte `unchanged` event per poll, about 58 KB an hour |
| A 170 KB snapshot over the wire when the browser accepts gzip | 170 KB | about 13 KB |
| Bot revision scan, 500-track queue and a full library, every 250 ms | about 29 ms of CPU per guild | about 0.4 ms |
| End of the 30-minute stream lifetime | "offline", controls disabled, a fresh GET | `event:rotate`, the next stream opens at once |

- **Change cursors.** A snapshot read reports the change-feed position taken
  before its authorization, and a command reports the entry it published. The
  portal skips a wake its last read already covers, so the command's own wake
  and the feed's wake for the same change cost one read. A wake that arrives
  during a read schedules one follow-up only if its entry is newer than that
  read. No cursor (old bot, feed without a consumer) means every wake reads.
  There is no coalescing window: the cursor removes the duplicate exactly, and a
  delay would only add latency.
- **Quiet streams.** Pages send `?protocol=2`. After each fresh read the stream
  compares what this viewer would see (everything but the ordering stamp and the
  playback position, which is checked against elapsed time with a 2 s
  tolerance) with the last snapshot it sent, and sends `event:unchanged` with the
  read's revision and ordering stamp when they match. The poll and its Discord
  authorization still run every 10 s, so revocation is seen as before. While a
  session plays or is paused, the saved checkpoint's time and position (hidden
  then, and rewritten every 30 s) don't count. The page renews its 25 s
  freshness lease from `unchanged` only when it shows exactly that stream's last
  snapshot; anything else gets a fresh read. Older pages keep full snapshots.
- **Compression.** Streams use gzip with a flush after every event (about half a
  megabyte per stream; brotli needs twice that). JSON replies use brotli or gzip
  above 1 KB. Bootstrap, which carries the CSRF token, is never compressed. No
  other reply carries a secret, and cross-site requests are refused, so there is
  no BREACH-style oracle. The only attacker-chosen text in a body is shared
  listening state every viewer of the session already sees.
- **Revision scan.** The library digests its saved settings and mixes once per
  write (stored guild objects are replaced, never mutated) and reads only
  history IDs and the raw checkpoint; track IDs are cached per track object
  while their identity fields are unchanged. `tests/portal-revisions.test.js`
  proves the cheap revision changes exactly when the old full one does.
- **Keep-alive.** The bot's bridge used a 1 s keep-alive, which Node's agent
  reads as "do not reuse": every read opened a new connection. It now keeps
  sockets 5 s and the portal retires idle ones after 4 s, so a request never
  lands on a socket being closed. A read whose reused socket still resets
  before any response is retried once; commands never are.

## Browser

`portal/web/src/optimistic.ts` and `usePortal.ts`:

- Pause, resume, seek, volume, filter, loop, radio, skip, skip-to, remove,
  move, clear and shuffle go into a per-guild FIFO, and the player shows the
  predicted result at once. One command reaches the bot at a time, in order.
- Set-state controls (pause/resume, volume, filter, loop, radio) carry no
  revision and coalesce: a newer choice replaces an unsent older one, and a
  choice that matches what will already be true sends nothing.
- Queue/position edits are checked before send: they go only if verified state
  still shows the exact tracks the user acted on, and they carry the latest
  verified revision. Otherwise they are dropped with an explanation. Their
  predictions stop applying as soon as newer verified state arrives.
- A rejection rolls back that change and everything queued behind it. Uncertain
  outcomes still force a fresh read and are never retried automatically.
- A song added from a search result appears at the end of the queue at once
  (unless fair queue picks its place) and doesn't block further additions; the
  bot's reply then confirms its position. Play next with a chosen result
  appears at the front the same way, but like a queue edit it's sent only while
  verified state still shows the queue the user acted on.
- Suggestion promote, remove and Less like this leave the suggestion list at
  once; they name their pick by id, which the bot checks. With repeat queue, Skip
  shows the song that was playing moving to the end of the queue.
- Permissions, revisions and freshness come only from verified snapshots.
- Nothing waiting on the bot locks other controls. Changes that need the bot's
  answer before the screen can show them (typed queries, Play next by text,
  favorites, mixes, replay, Back, saved-session resume, vote skip) join the same
  ordered queue as playback changes, so a tap made meanwhile is queued, shown
  where it can be, and sent after them: "Waiting for confirmation · N queued".
  A second identical tap while the first is on its way is recognized, not sent.
  When a revision-checked change is confirmed and its result still shows the
  songs a later queued change saw, that change is bound to the result instead of
  failing with a self-made 409; if the songs moved (Back brought in another
  song), it conflicts and asks for a deliberate retry. Changes clicked over this device's own still-settling
  predictions still use the confirmed revision when the verified tracks match
  what was shown. A rejected change that wasn't predicted leaves the taps behind
  it queued; a rejected prediction still rolls back everything built on it.
- Library-only changes (favorite remove, clear and import, mix delete and
  import, server settings) never depend on the session on screen. They go in a
  second ordered queue beside playback, so a pause is sent at once even while a
  favorite is saving. Stop still cancels unsent playback changes, not these.
- Hearts flip at once. Each song keeps the listener's latest choice and sends
  what it takes to reach it, one change at a time, so rapid taps end where the
  last one left the heart. A refusal puts the heart back and says why. The
  library is patched with the confirmed change and re-read quietly behind it.
  A favorite tapped from this device's own lists follows its song to where this
  device's edits moved it; a number typed against older state still conflicts.
- Returning to the app (or coming back online) with a live, fresh stream keeps
  every control usable: no banner, only a quiet snapshot check. Its answer is
  taken only when its ordering shows it's newer than what the stream delivered;
  without comparable ordering, a different revision takes the ordinary fresh
  read. A refresh, disconnect or lost freshness while it's out discards it. The
  library is re-read on return only when it may be out of date (older than a
  minute, or a song changed while the page was hidden). Stale state still takes
  the ordinary fresh read with controls held until it lands.
- A song change re-reads history quietly once rapid skips settle (1.5 s).
- Songs added on this device while an earlier one is still being looked up wait
  their turn instead of being dropped.
- Controls stay usable while changes settle. "Syncing with Discord…" appears
  only when confirmation takes longer than 700 ms.

This deliberately replaces the earlier rule that the player must never predict
playback state. Prediction is display-only: the bot still authorizes and
executes every write, and the screen converges on verified state.

## Gateway authority for audible controls

Pause, resume, seek, volume, filter, skip and skip-to no longer wait on a
Discord REST round before the playback write. With the GuildMembers intent,
Gateway push events keep every authorization input current: guild owner, role
definitions, the actor's roles and timeout, channel overwrites and voice state.
`policy.gatewayGuild` builds the same detached, request-local authority view
from that cache, and the same native guard and portal checks (membership,
same voice channel, channel visibility, DJ role) run against it. It is
event-sourced state, not a time-based cache, and grants no maintainer access.

Adding a song (play, play next) uses the same authority. Before this, one web
addition made eight fresh REST rounds (admission, lane preflight, the native
voice guard, a recheck after the lookup and after each of enqueue, connect and
start, then the final disclosure): 56 Discord reads and, at the 300-570 ms
measured per round, several seconds. Every recheck still runs, against Gateway
state, so leaving or moving voice or losing the DJ role during a slow lookup
still stops the addition. Only the final disclosure reads REST
(`tests/portal-gateway-authority.test.js`). Two smaller savings come with it: a
song chosen from portal search is added from the track that search already
loaded (kept per listener for five minutes) instead of loading its link again,
and the Discord controller edit no longer holds the web reply.

It returns nothing, and the command takes the fresh REST round as before, when
the cache can't be trusted: no members intent, the guild's shard not Ready
(missed events replay on resume), or a missing actor, bot member or @everyone
role. Stop, queue edits, settings, library actions and every final disclosure
keep fresh REST authority.

The trade-off: a permission change takes effect when its Gateway event
arrives (normally well under a second) rather than at the next REST read.

Public Funnel adds about 35 ms to a warm request (76 ms through the public
ingress vs 41 ms direct over the tailnet, with the portal answering in 8 ms
locally, measured 2026-10-07). It is not worth replacing.

## Local evidence

- With 35 ms injected per Discord route, one fresh authorization takes one
  network round for an actor in voice (two otherwise), versus two after
  `669962a` and four before it (`tests/portal-identity-latency.test.js`).
- Queue/transport commands authorize twice instead of four times
  (`tests/portal-control-latency.test.js`).
- With polling pushed out to a minute, the compiled browser saw a Discord-side
  pause in 25-55 ms, a silent queue edit in 210-715 ms and a voice leave in
  15-20 ms across runs (`portal/integration/change-feed-browser.test.js`).
- The player updates inside a 250 ms assertion window after a click while the
  bot reply is held (`portal/web/tests/instant-controls.http.spec.ts`).

## Verification gaps

Local fixtures prove ordering, coalescing, rollback and the reduced number of
authorization rounds. Real Discord REST latency, rate-limit behavior and
audible delay have to be measured on the deployed bot; compare the private
`/v1/latency` authorization timings before and after deployment.
