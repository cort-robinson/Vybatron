# Vybertron v2 contract

## Goal and architecture

A reliable shared Discord music experience on desktop and mobile. Node >=22.12, ESM, discord.js14, exactly pinned lavalink-client2.10.3, and Lavalink4.2.2 with DAVE voice support. Guilds and GuildVoiceStates intents only. Slash commands and Discord components only.

Lavalink is the sole audio engine. `player.queue` is the sole live queue. Music libraries store catalog references; they never introduce a parallel live queue or retain playable encodings. The bot uses standard server filters and does not download or save audio.

## Invariants

1. Startup validates configuration, opens and validates saved data, and loads commands before login. Required credentials and malformed settings fail with credential-free errors.
2. Complete command registration is atomic from the caller's perspective: an incomplete/invalid catalog fails before the Discord PUT. Commands are server-only.
3. Playback requests require an accessible voice channel and cannot move an existing session to another user's channel. Long lookups recheck voice membership, player identity, stopping/draining state, and DJ access where applicable before enqueueing.
4. Shared controls require the bot's voice channel and a configured DJ role or Manage Server. Normal adds, personal favorites, and majority vote skip remain available to listeners. Read-only help/queue/history do not require voice access.
5. Mutations acknowledge Discord immediately, serialize per guild, and have bounded backlog. Stop and radio-off bypass slow catalog work. A stopped or replaced session rejects late lookup results. Every playback request releases its maintenance counter.
6. Track attempts have unique wire tokens. Duplicate, stale, replaced, or superseded failure events cannot advance the queue twice or resurrect an old request.
7. Stream recovery is bounded: fresh exact lookup first, conservative provider mirrors only when identity can be preserved, limited delays and retries, and source circuit breakers. Individual private/removed/region restrictions do not trip an infrastructure circuit.
8. Voice credentials use fresh matching state/server gateway events in either order and carry channelId. Incomplete handshakes time out. A resumed Lavalink session must also have connected Discord voice; otherwise request a fresh handshake. Unsupported terminal voice failures remain visible without a rejoin storm.
9. Progress recovery uses server-reported position, not the SDK's extrapolated clock. Pause, deliberate seek, live streams, mute, disconnected voice, and end-of-track states must not cause false recovery.
10. Each listening session has at most one active public controller. Track, queue, and state changes edit it. Stale controller IDs cannot control a replacement session. Private confirmations and menus are owner-bound when appropriate; custom IDs are unique within a payload.
11. Recovery shows Recovering or Audio Unavailable truthfully. Skip and Stop remain usable. Presence and optional voice status cannot block playback or disconnects.
12. Five minutes with no queued/current track or with no human listener disconnects the player. Empty-voice timers do not reset on unrelated voice events or track changes.
13. Radio is explicitly opt-in for the current session. It inserts one related track only when the human queue is empty and people are present, rechecks before insertion, and has bounded lookup/failure behavior. Radio-off or destroy prevents late insertion.
14. Atomic library transactions publish in-memory state only after durable replacement. Concurrent writes cannot lose each other. Invalid/oversized libraries fail closed without overwriting evidence. Saved data excludes audio, signed URLs, credentials, encoded tracks, and arbitrary userData.
15. Libraries are scoped by server and owner. Limits:100 personal favorites,25 shared mixes/server,100 tracks/mix,500 upcoming tracks,1000 servers,5MiB file. Mix edits require owner or Manage Server.
16. Session checkpoints contain current+upcoming public references, reported position, pause/volume/repeat state, and channel IDs. They expire after72hours. Restore is explicit and requires the original voice channel and DJ access. Initial play restores position and pause atomically. Intentional Stop clears the checkpoint; interrupted transport/shutdown retains a useful checkpoint.
17. Spotify embed fallback uses only public whitelisted catalog fields, never embedded credentials, cookies, or preview audio. Matches require conservative title/artist/version/duration agreement. Imports cap100 listed tracks,4 concurrent lookups,60seconds overall, and report partial results. Public embed collections are not claimed complete.
18. Fatal runtime errors trigger bounded graceful shutdown and a failure exit. Shutdown gates requests, invalidates retries, flushes snapshots/library before disconnect, closes transports, and completes within the configured deadline.
19. Diagnostics are loopback-only with strict HTTP methods. `/live` checks responsiveness; `/ready` and `/health` check Discord/audio readiness; `/status` exposes aggregate counts and recovery counters. Operator playback diagnostics retain only bounded public video IDs/timestamps.
20. Images/dependencies are pinned. Source changes require published artifacts and actual full decoded playback, including FINISHED. Search/metadata or an HTTP health check alone never proves audio.
21. Releases deploy an exact successful main-push CI SHA, wait for an idle queue, retain actual audio images, record rollback before changes, pass full audio probes and catalog registration, then verify readiness and exact release identity. An interrupted journal blocks automatic recovery. WARP namespace replacement includes its audio dependents.
22. Secrets stay outside Git and user-facing logs. Optional voice status, controller writes, or failed alerts cannot crash or block the audio path.

## Commands and storage

The25-command catalog is documented in [README.md](README.md). `src/commands` defines commands; `deploy-commands.js` validates/registers the same catalog. `src/playback-recovery.js` is the narrow adapter around the pinned SDK; `src/playback-watchdog.js` checks progress. `src/utils/library.js` persists version1 JSON in `VYBERTRON_DATA_DIR/library.json`. `src/utils/sessions.js` records checkpoints every15seconds and after state changes. `ops/recovery.py` tests sources and performs bounded repairs; `ops/deploy.py` owns exact release transactions and rollback.

## Verification boundaries

Node tests cover command/interaction guards, libraries, queue ownership, filters, radio, recovery/watchdog, and native SDK contracts. Python tests cover recovery and deployment policies. Container checks cover non-root persistence, read-only runtime, memory configuration, WARP daemon supervision, and Compose. Isolated source probes decode real audio; final acceptance additionally requires audible Discord listening on Windows and phone. See [docs/v2-launch.md](docs/v2-launch.md).