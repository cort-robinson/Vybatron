# Glossary

Domain terms for Vybertron. One meaning per term; commands, code, and docs use these words consistently.

- **Track** — one playable item (song/video) with title, URL, duration, source, and **requester**. Produced by a **search**; lives in a **queue**.
- **Requester** — the Discord user who enqueued a track. Attached at search time, shown in embeds.
- **Queue** — per-guild ordered list of upcoming tracks, owned by the **player** (lavalink-client built-in). Single source of truth: every command reads/writes this queue and no other.
- **Player** — per-guild playback session on the Lavalink server, addressed via `lavalink.getPlayer(guildId)`. Holds current track, queue, volume, pause state, and the voice/text channel bindings.
- **Node** — one Lavalink server connection. We run exactly one (`main`).
- **Lavalink** — standalone Java audio server (v4). Fetches, decodes, and streams audio to Discord; the bot only sends it commands.
- **youtube-source** — Lavalink plugin providing YouTube + YouTube Music support (v4 removed built-in YouTube).
- **LavaSrc** — Lavalink plugin resolving Spotify (and other) links to metadata, mirrored to YouTube for audio.
- **Mirroring** — playing a Spotify-identified track by finding its closest YouTube match (Spotify has no streaming API).
- **Search** — resolving a user query to tracks. URLs load directly; plain text uses a source prefix (`ytsearch:` default, `ytmsearch:`, `spsearch:`, `scsearch:`).
- **Announce channel** — the text channel where `/play` was invoked; receives the one "Now Playing" embed per track start.
- **Control command** — any command that mutates playback (`/skip`, `/stop`, `/volume`, `/shuffle`, `/pause`, `/resume`, `/skipto`). Requires invoker in the bot's voice channel.
- **Idle timeout** — 5-minute timer started when the queue empties or the voice channel becomes humanless; on expiry the player disconnects and is destroyed.
