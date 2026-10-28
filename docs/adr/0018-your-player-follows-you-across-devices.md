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
listener signs in on, and at most one device plays it at a time: the **active device**. With no
active device, the player is paused where it stopped.

One player per listener, not per server, because the listener's devices follow the listener. The
player keeps the server it was started in for its audio and analysis requests, which stay
membership-checked per request (ADR-0011). Starting music from another server's page moves the
player to that server.

### Devices

- **A device is a signed-in browser or app.** It gets a random ID the first time it connects,
  kept in its storage, and a name the listener can change (by default the platform and browser,
  for example "Android app" or "Firefox on Linux"). The device's ID, name and when it was last
  seen are saved with the listener's player (below), tied to the session that registered it.
  Which devices are connected right now is kept only in the portal server's memory. Signing out
  removes the device, and a device that hasn't connected for 30 days is forgotten. At most 10
  devices per listener.
- **Each device says what it can do.** It can play, or it can only control. A browser page can
  play only after the listener has interacted with it, because browsers block audio that starts
  by itself. Until then it is listed as "tap to play here". The Android app (and later the TV
  app) can always play.
- **A per-listener live stream.** Each device opens `GET /api/me/events` alongside the server
  stream it already has. It carries the player, the device list, which device is active, and
  commands for this device. It has the server stream's limits, rotation and heartbeats, and
  `streamsPerSession` rises from 2 to 3 to fit it. Commands go to `POST /api/me/player`, with the
  session, CSRF and rate-limit checks of today's command route.

### Who decides what

- **The active device owns the playhead.** It decides when a song ends and the next starts,
  where it is, and whether it is playing, because it must keep going with the screen off or the
  network gone (the Android player already does this). It reports to the portal on every change
  and every 15 seconds while playing.
- **The portal server owns the queue.** Edits from any device (add, remove, move, clear,
  shuffle) are applied on the server with a revision number, and a stale edit is refused, as the
  Android player's queue already refuses stale revisions (`DeviceQueue.kt`). The active device
  follows the new revision.
- **Remote controls are relayed.** Play, pause, seek, next, previous, skip-to, volume and repeat
  from another device are sent to the active device, which carries them out and reports the
  result. With no active device, the server applies them to the paused player directly.
- **One shared clock.** Positions are reported as "position P at server time T". Each device
  estimates its offset from the server's clock from the timestamps on its live stream, so a remote
  can show the moving position and its visualizer can follow the active device's song. A
  Bluetooth output adds its reported latency to the position the device reports.

### Pick up anywhere

The player is saved in the bot's listening-state store (ADR-0009), as a new table, so it is
covered by the existing backups (`ops/backup.py` copies `listening-state.sqlite`). The portal
writes it through the bridge on every song change, pause, seek or queue edit, and every 15 seconds
while playing, like session checkpoints today. It is bounded: 500 queued songs, 50 history songs,
64 KiB per listener, and a player unused for 90 days is deleted. Players count toward the
store's 8 MiB guard, shed after history and activity. Unlike history and checkpoints,
players are not mirrored into `library.json`. A rollback to an older bot loses only where each
listener left off.

A device that opens the portal shows the player. If no device is active, Play starts it on this
device at the saved position. The browser's `localStorage` copy stays only as a cache for showing
the player before the stream connects. The first time a device connects after this change, it
uploads its saved deck if the listener has no player yet, so nobody loses their queue.

### Handoff

Moving playback from device A to device B, started from any device:

1. **Prepare.** The portal tells B to load the current song and buffer it at the position it will
   have in about a second. A keeps playing. The audio is already in the bot's audio cache
   (`src/portal/audio.js`) because A is playing it, so B's request doesn't wait for YouTube.
2. **Ready.** B replies when it can start immediately, with its output latency.
3. **Switch.** The portal picks a server time T at least 250 ms ahead and tells both. At T, B
   starts at the position for T and fades in over 150 ms, and A fades out over 150 ms and stops.
   B is now the active device.
4. **Fallback.** If B isn't ready in 8 seconds, nothing changes and the device that asked says so.
   If A is gone (switched off, out of network), B starts from A's last report, a resume rather
   than a seamless handoff.

The two devices are usually in different places, so they are not kept in sample-accurate sync.
The fade covers the small overlap or gap left by clock and output-latency estimates. The target is
no audible gap and less than 100 ms of jump in the song.

**Discord is one of the places to play.** The device picker lists the listener's devices and, when
they are in a voice channel, Discord. Moving to Discord is today's `transfer` and moving back is
today's *Play here*. While the music is in Discord, the player shows the Discord session with its
existing controls. Making those moves seamless is out of scope: the bot's playback starts through
Lavalink with its own buffering.

### The Android app

When it is the active device, the app has to stay reachable with its page closed. Today the page
relays everything to the native player, so with the screen off no remote could reach it. The
playback service keeps its own connection to `/api/me/events` while it is the active device,
sending reports and taking commands, with the session cookie and only to the portal origin, as its
audio requests already do (ADR-0016). It closes that connection when another device takes over or
playback stops. New bridge operations follow ADR-0016's named-type rule: `player.prepare` and
`player.switchAt`.

### Order

1. **Shared player and remote control.** The listening-state table, the device list, the
   per-listener stream, the server-owned queue, relayed controls, the device picker in the
   player menu, and moving playback by stopping A and then starting B. The Android service keeps
   its own connection.
2. **Seamless handoff.** Prepare, ready and switch, with fades, in the browser and the app.
3. **Devices to come.** A TV app joins as one more device, with its own ADR for TV sign-in. Cast
   Connect, if wanted, becomes another way to start the same handoff on the TV.

## Consequences

- **The portal server is no longer only a proxy.** It keeps devices, relays commands and runs
  handoffs, all in memory. A portal restart drops the device list until devices reconnect, which
  they do in seconds. Music keeps playing through a restart, because the active device owns the
  playhead.
- **More traffic through the bridge.** About one write every 15 seconds per playing listener.
  This is the same rate as Discord session checkpoints.
- **Two devices can disagree briefly.** If the active device is offline while another device edits
  the queue, the active device catches up when it reconnects. Its playhead wins, and the server's
  queue wins.
- **Browsers can't be woken.** A browser tab must be open and must have been tapped to play. A
  phone or TV app can always take over. A closed browser isn't listed as able to play.
- **Sign-in still lasts 7 days.** That is fine on a phone and annoying on a TV. Longer sign-ins
  for TV and app devices belong in the TV sign-in ADR.
- **One device plays at a time.** Playing the same queue in sync on several devices, as a party
  or multi-room mode, is a different design and is not part of this one.
- **Tests to add:** queue-revision and relay tests on the portal server; a handoff test in
  Playwright with two pages and a fake clock; Kotlin tests for prepare and switch; and an
  instrumented test that the app takes a remote pause with its activity gone.
