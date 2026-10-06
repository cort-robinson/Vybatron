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
  Gateway voice joins/moves and channel, role and guild updates. Member role
  edits need the privileged members intent and stay on polling. The scan runs
  only while a consumer polled within the last minute.
- `portal/server`: one follower long-polls the feed on its own socket, outside
  the protected request pool. Each wake makes the stream do its own fresh
  authorized read. Snapshots are never shared between actors. A reset, a new
  bot instance or a recovered feed wakes every stream. When the feed fails,
  streams fall back to 3 s polling.

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
- Permissions, revisions and freshness come only from verified snapshots.
  Other actions (favorites, mixes, settings, play/add) keep the one-at-a-time
  lock. When they were clicked over this device's own still-settling
  predictions and the verified tracks match what was shown, they use the
  confirmed revision instead of failing with a self-inflicted 409.
- Controls stay usable while changes settle. "Syncing with Discord…" appears
  only when confirmation takes longer than 700 ms.

This deliberately replaces the earlier rule that the player must never predict
playback state. Prediction is display-only: the bot still authorizes and
executes every write, and the screen converges on verified state.

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
