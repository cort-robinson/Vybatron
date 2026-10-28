# ADR-0018: Your player follows you across devices

- Status: Proposed
- Date: 2026-10-28
- Amends: [ADR-0014](0014-android-app-with-on-device-youtube-music-account.md) (the app's player
  owns its queue on the phone; it now shares it with the listener's other devices)

## Context

A listener can play songs on their own device instead of in Discord (`portal/web/src/playback.ts`,
the Android app's `DevicePlayer`). That player belongs to one browser:

- **Its state stays on the device.** The queue, current song, position, volume and repeat are
  saved in that browser's `localStorage` (`vybertron.local`) or in the Android app's player. A
  listener who opens the portal on another device starts from nothing.
- **Nothing knows about devices.** A portal session is a Discord user and a cookie
  (`portal/server/src/store.js`). Live updates are per server (`/api/guilds/:guild/events`), and
  a device can't see or control another device's player.
- **The only move is to and from Discord.** `transfer` sends this device's queue into the voice
  channel, and *Play here* copies the Discord session onto this device. Both stop one side and
  start the other, with a gap while the new side loads.

The listener wants three things, the way Spotify Connect works:

1. **Pick up anywhere.** Open the portal or app on any signed-in device and be where they left off.
2. **Any device is a remote.** Every signed-in device shows what is playing on the device that
   plays and can control it: play, pause, seek, skip, volume, repeat and queue edits.
3. **Seamless handoff.** Moving playback from one device to another continues the same song at
   the same moment, without a noticeable gap.

A TV app (Android TV, later) and possibly Cast Connect will be more devices of the same kind, so
the design must not assume a phone or a browser.

## Decision

**One player per listener, shared by their devices.** Each Discord user has one player: the
current song, the queue, recent history, the position, playing or paused, volume and repeat, and
the server (guild) whose audio route it plays through. It is the same player on every device the
listener signs in on. One device at a time owns its playback: the **active device**. With no
active device, the player is paused where it stopped.

One player per listener, not per server, because the listener's devices follow the listener. The
player keeps the server it was started in for its audio and analysis requests, which stay
membership-checked per request (ADR-0011). Starting music from another server's page moves the
player to that server.

### Where the state lives

- **The bot's store is the record.** The player is a new table in the bot's listening-state store
  (ADR-0009), so it survives restarts of either process and is covered by the existing backups
  (`ops/backup.py` copies `listening-state.sqlite`). Every change to it is one transaction in the
  store's write queue, checked against the player's revision.
- **The portal server coordinates.** It knows which devices are connected, relays commands
  between them and runs handoffs, all in memory. It reads and changes the player only through the
  bridge, as the actor of the session that asked.
- **Bounds.** At most 500 queued songs, 50 history songs and 256 KiB per player, with each song's
  stored title, artist and artwork address capped in length. An add past either limit is refused
  with "Your queue is full". Every bridge request stays within the bridge's 16 KiB body limit, so a
  large add is sent in batches. Reads use the response limit (4 MiB). All players together are
  capped at 2 MiB, least recently used shed first, and a player unused for 90 days is deleted.
  That fits inside the store's existing 8 MiB guard, next to the about 5 MiB of history, activity
  and checkpoints that ADR-0009 bounds, so the guard and the release snapshot's 64 MiB budget
  don't change. Players aren't mirrored into `library.json`: a rollback to an older bot loses only
  where each listener left off.

### Devices

- **A device is a signed-in browser or app.** It gets a random ID the first time it connects,
  kept in its storage, and a name the listener can change (by default the platform and browser,
  for example "Android app" or "Firefox on Linux"). The device's ID, name and when it was last
  seen are saved with the player, tied to the session that registered it. Signing out removes the
  device, and a device that hasn't connected for 30 days is forgotten. At most 10 per listener.
- **A per-listener live stream.** Each device opens `GET /api/me/events` alongside the server
  stream it already has. It carries the player, the device list, which device is active, and
  commands for this device. It has the server stream's limits, rotation and heartbeats, and
  `streamsPerSession` rises from 2 to 3 to fit it. Changes go to `POST /api/me/player`, with the
  session, `Origin`, CSRF and rate-limit checks of today's command route.
- **Can it play right now?** A device is offered as a place to play only while its live stream is
  connected and it can start audio. A browser tab must have been tapped since it loaded, because
  browsers block audio that starts by itself, and is listed as "tap to play here" until then. The
  Android app counts while its playback service is connected (below). A device that isn't
  connected is listed as "open the app to play here".

### Who decides what

- **Ownership has a generation.** Becoming the active device increments the player's
  **generation**, saved with the player, so it survives a restart of either process. A
  generation has a start time: at once for a plain move, the switch time T for a handoff (below).
  Every report from a device carries the generation it plays under, and once a newer generation
  has started the store refuses reports from older ones. A device whose report is refused, or
  which sees a newer generation that has started, stops playing at once. Only the active
  device's reports change the playhead.
- **The active device owns the playhead.** It decides when a song ends and the next starts, where
  it is, and whether it is playing, because it must keep going with the screen off or a brief
  network loss (the Android player already does this). It reports every song change, pause and
  seek, and its position every 15 seconds while playing.
- **The store owns the queue, by entry.** Each queued song has an **entry ID**, so the same song
  twice is two entries. Every edit names entries, not positions (add after entry X, remove entry
  Y, move entry Z before entry W), carries the revision it was made against, and changes the
  current song, the queue and history together, as the Android queue already does
  (`DeviceQueue.kt`). An edit against an old revision is refused, and the device that made it
  reloads and retries.
- **Advancing is an edit too.** The active device reports "from entry A to entry B" with its
  generation. The store moves A to history and makes B current, wherever B is in the queue, which
  can't leave B both playing and upcoming. If a remote removed B meanwhile, B still becomes
  current, because it is what's playing. Reports are idempotent, so a device that advanced while
  offline sends them in order when it reconnects. If a newer generation took over meanwhile, they
  are refused and that device stops (above).
- **Remote controls are relayed.** Play, pause, seek, next, previous, skip-to, volume and repeat
  from another device are sent to the active device, which carries them out and reports the
  result. With no active device, the store applies them to the paused player directly.
- **One shared clock.** Each device measures its clock offset from the server with round trips
  (a small timing request, several samples, keeping the one with the shortest round trip and its
  half-round-trip as the uncertainty). Positions are reported as "position P at server time T",
  so a remote can show the moving position, and its visualizer can follow the active device's song.
  A device adds its audio output's reported latency, including Bluetooth's, to the position it
  reports.

### Pick up anywhere

A device that opens the portal shows the player. If no device is active, Play makes this device
the active one at the saved position.

A browser keeps a copy of the player only to show it before its stream connects. The copy is
keyed by the signed-in Discord user and shown only to that user. Today's `vybertron.local` deck
belongs to no account, so it is never uploaded by itself: the first time a device connects after
this change, if that deck exists, the device asks the listener whether to add it to their player,
then deletes it either way. A saved deck past the bounds keeps its first 500 songs, and the device
says so.

### Handoff

Moving playback from device A to device B, started from any device:

1. **Prepare.** The portal gives the handoff an ID and binds it to the current generation, the
   current entry and the player's **playback version**, which changes on every song change,
   pause, play and seek. It tells B to load that entry and buffer it at the position it will have
   when the switch happens. A keeps playing. B's audio may already be in the bot's audio cache
   (`src/portal/audio.js`) because A played it, but the cache can evict it, and a request from the
   middle of a song waits for the whole download. So the cache is only an optimization.
2. **Ready.** B replies only when it has buffered audio at that position and can start at once.
   With the reply comes its output latency and its clock uncertainty. If the playback version
   changes before then, the handoff is prepared again from the new state. If B isn't ready in 15
   seconds, the handoff is cancelled, A keeps playing, and the device that asked says why.
3. **Commit.** The portal picks a server time T far enough ahead for both devices' measured round
   trips, plus a margin, and never in the last 2 seconds of a song (it waits for the next one).
   The store records the next generation for B, starting at T, only if the playback version is
   still the one the handoff was prepared for. That one write is the commitment. Until it
   happens, nothing has changed, and a cancelled handoff needs no clean-up. Then the portal sends
   the commitment to both devices.
4. **Switch.** B starts at T only if it has seen the commitment, from the portal's message or from
   the generation on its stream. It starts at the position for T and fades in over 150 ms. A fades
   out over 150 ms and stops at T. Remote controls that arrive between the commitment and T are
   held and sent to B after T. If A's own buttons change playback in that window (its
   notification, for example), its report doesn't match the bound playback version, so the store
   withdraws the commitment. B then stops if it already started, and A keeps playing.

Losing a message is handled by the stored generation. If A misses the commitment, both play until
A reconnects, sees the newer generation and stops. That overlap is accepted rather than risking
silence. If B misses it, A stops at T and B starts when it reconnects and sees that it is the
active device, from the position for that moment. A portal restart cancels handoffs that weren't
committed. A committed one stands, and the devices act on the stored generation when they
reconnect.

The two devices are usually in different places, so they are not kept in sample-accurate sync.
The fade covers small clock and output-latency errors. The target is no audible gap and less than
100 ms of jump in the song. When either device's clock uncertainty is over 50 ms, the handoff falls
back to a plain resume: A stops, and B starts from A's reported position.

If A is gone (switched off, out of network), the move skips the handshake: the generation passes
to B, and B starts from A's last report. If A was still playing on buffered audio, it stops when it
reconnects.

**Discord is one of the places to play.** The device picker lists the listener's devices and, when
they are in a voice channel, Discord. Moving to Discord is today's `transfer` and moving back is
today's *Play here*. While the music is in Discord, the player shows the Discord session with its
existing controls. Making those moves seamless is out of scope: the bot's playback starts through
Lavalink with its own buffering.

### The Android app

The app must stay reachable with its page closed, but today the page relays everything to the
native player. So the playback service keeps its own connection to `/api/me/events` and sends its
own reports, only to the portal origin (ADR-0016). It holds that connection for as long as the
service runs, whether or not it is the active device, so it can be handed playback back. The
service's lifetime is unchanged: it ends when the app is swiped away while paused. After that the
app is listed as "open the app to play here".

Its requests need the same checks as the page's: the session cookie from the WebView's cookie
store, which it already uses for audio, the portal origin as `Origin`, and the session's CSRF
token. The page hands it the token over the bridge (`player.subscribe`) whenever it loads. If the
portal refuses the session (signed out, expired, or replaced by a new sign-in), the service closes
its connection and stops sending reports. The song in progress keeps playing on the phone, and the
next time the page opens it starts over with the new session.

New bridge operations follow ADR-0016's named-type rule: `player.prepare` and `player.switchAt`.

### Order

1. **Shared player and remote control.** The store table, generations and entry IDs, the device
   list, the per-listener stream, the clock, relayed controls, the device picker in the player
   menu, and moving playback by a plain resume (A stops, B starts). The Android service keeps its
   own connection.
2. **Seamless handoff.** Prepare, ready, schedule and switch, with fades, in the browser and the
   app.
3. **Devices to come.** A TV app joins as one more device, with its own ADR for TV sign-in. Cast
   Connect, if wanted, becomes another way to start the same handoff on the TV.

## Consequences

- **The portal server is no longer only a proxy.** It keeps the connected devices, relays commands
  and runs handoffs, in memory. A portal restart cancels handoffs in progress and drops the list of
  connected devices until they reconnect, which takes seconds. Music keeps playing through a
  restart, because the active device owns the playhead and the generation is in the store.
- **More traffic through the bridge.** About one write every 15 seconds per playing listener, the
  same rate as Discord session checkpoints.
- **Two devices can briefly play together.** That happens only when the active device lost its
  connection during a move. It stops when it reconnects.
- **Browsers can't be woken.** A browser tab must be open and tapped to play, and the Android app
  only while its service runs. A TV app that keeps a service running would always be available.
- **Sign-in still lasts 7 days.** That is fine on a phone and annoying on a TV. Longer sign-ins for
  TV and app devices belong in the TV sign-in ADR.
- **One device plays at a time.** Playing the same queue in sync on several devices, as a party or
  multi-room mode, is a different design and is not part of this one.
- **Tests to add:** store tests for generations, entry-based edits, stale revisions and offline
  advance reports; portal tests for relays, handoff cancellation and partial delivery; a Playwright
  handoff test with two pages and a controlled clock; Kotlin tests for prepare and switch; and an
  instrumented test that the app takes a remote pause with its activity gone.
