# ADR-0001: Lavalink as the sole audio engine

- Status: Accepted
- Date: 2026-07-08

## Context

The codebase currently wires two audio engines at once: `/play` enqueues tracks through Vulkava (a Lavalink client), while every other command (`/skip`, `/queue`, `/pause`, etc.) reads queue state from discord-player (`player.nodes`). The two engines never share state, so the bot cannot function — a track started via `/play` is invisible to `/skip`.

The discord-player path additionally stacks four fragile YouTube extraction fallbacks (youtubei, play-dl, ytdl-core, ytdl-core-discord), all of which break whenever YouTube changes its internals, and requires cookie babysitting (`YT_COOKIE`, a Puppeteer helper script).

## Decision

Lavalink v4 is the only audio engine. All discord-player code and its extraction dependencies are removed: `discord-player`, `@discord-player/extractor`, `discord-player-youtubei`, `ytdl-core`, `ytdl-core-discord`, `play-dl`, `youtube-ext`, `mediaplex`, `opusscript`, `@discordjs/opus`, `@discordjs/voice`, `ffmpeg-static`, `node-wit`, and the Puppeteer cookie helper.

YouTube playback reliability is handled server-side by the maintained `youtube-source` Lavalink plugin (Lavalink v4 removed built-in YouTube support).

## Consequences

- The bot process becomes thin: no audio decoding, no ffmpeg, no opus. Voice data flows Lavalink → Discord directly.
- A Lavalink server must run alongside the bot (see ADR-0005 for how).
- YouTube breakage is fixed by updating the youtube-source plugin version in Lavalink config — no bot code changes.
- `src/player.js` and the `YT_COOKIE` machinery are deleted.
