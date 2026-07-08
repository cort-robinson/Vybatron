# ADR-0004: Source resolution and playback behavior

- Status: Accepted
- Date: 2026-07-08

## Context

Required sources: YouTube and YouTube Music links (minimum), plus Spotify links, SoundCloud, and full playlists. Lavalink v4 has no built-in YouTube support, and Spotify offers no streaming API — Spotify links must be resolved to metadata and mirrored to another source.

Behavioral gaps in the old bot: it announced every track start *and* end (two messages per song), never auto-disconnected, and had no rule about who may control playback.

## Decision

**Sources — resolved server-side in Lavalink via plugins:**
- `youtube-source` plugin: YouTube + YouTube Music (links, searches, playlists).
- `LavaSrc` plugin: Spotify link resolution (requires free Spotify API client ID/secret in Lavalink config), mirrored to YouTube for actual audio.
- SoundCloud: Lavalink built-in.

**Playback behavior:**
- Control commands (`/skip`, `/stop`, `/volume`, `/shuffle`, `/pause`, `/resume`, `/skipto`) require the invoker to be in the bot's current voice channel.
- Announce track start only (one "Now Playing" embed per song). No track-end messages.
- No autoplay: when the queue empties, a 5-minute idle timer starts; on expiry the bot disconnects. The bot also disconnects when its voice channel becomes empty. `/stop` disconnects immediately.
- Volume range 0–100, default 100, not persisted across restarts (v1).

## Consequences

- Spotify requires `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` from developer.spotify.com wired into Lavalink's `application.yml` (via environment variables in docker-compose).
- Playlist links enqueue all tracks; the reply reports the count.
- The voice-channel guard is a small shared helper used by every control command.
