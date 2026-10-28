# ADR-0013: The bot measures songs for the portal's visualizers

- Status: Accepted (chosen by the maintainer over the plugin route, 2026-10-28)
- Date: 2026-10-28
- Amends: [ADR-0001](0001-lavalink-sole-audio-engine.md) ("The bot process becomes thin: no
  audio decoding, no ffmpeg, no opus")

## Context

The portal's visualizers moved to motion generated from each song's id, because the browser
never receives the Discord audio. Analysing this device's own playback in the browser would
need Web Audio, and routing the media element through it stops background playback on iOS.
Real reactivity needs the song's energy measured somewhere else and looked up by position,
which works the same for Discord playback and this device.

The bot already fetches each YouTube song as Ogg Opus from our Lavalink plugin for this
device's player (`src/portal/audio.js`). The analysis could live in that plugin instead, but
that is a change to the audio services, which are held for separate approval and need
decoded canaries.

## Decision

The bot decodes a song only to measure it, never to play it. Lavalink stays the only playback
engine, and nothing the bot decodes reaches Discord or a listener.

- **One download path.** The song comes through the existing device-playback audio cache.
  Only the plugin's `audio/ogg` is measured; the YouTube plugin's mp4/webm fallbacks stay
  unmeasured and the visualizer keeps its generated motion.
- **WebAssembly, no native code.** Opus is decoded by the `opus-decoder` package (MIT, pinned
  exactly), which runs unchanged on the Alpine image after `npm ci --omit=dev`. The bot
  demuxes Ogg itself.
- **Off the event loop.** Each song is measured in a worker thread that ends with it: about
  1.4 s of CPU for a four-minute song, none of it on the thread serving Discord and Lavalink,
  and the decoder's WebAssembly memory goes with the worker. One song at a time, about 45 MB
  at peak; others are asked to retry.
- **Small results.** 16 bands at 30 frames a second plus beat markers, about 160 KB as served,
  kept in a 24-song in-memory LRU. Nothing is written to disk.

## Consequences

- The bot is no longer free of audio decoding, though Discord playback still never passes
  through it. The purity test's forbidden playback modules stay forbidden.
- Opening a visualizer on a song the portal hasn't played on a device makes the plugin fetch
  and encode it once more, beside Lavalink's own playback.
- Spotify-matched and other non-YouTube songs keep generated motion until the bot can name a
  YouTube video for them.
- Moving the measurement into the plugin later only changes where the bridge gets its map;
  the contract (docs/portal-contract.md, `SongAnalysis`) stays.
