# Glossary

Domain terms for Vybatron. One meaning per term; commands, code, and docs use these words consistently.

- **Track** — one playable item (song/video) with title, URL, duration, source, and **requester**. Produced by a **search**; lives in a **queue**.
- **Requester** — the Discord user who enqueued a track. Attached at search time, shown in embeds.
- **Queue** — per-guild ordered list of upcoming tracks, owned by the **player** (lavalink-client built-in). Single source of truth: every command reads/writes this queue and no other.
- **Player** — per-guild playback session on the Lavalink server, addressed via `lavalink.getPlayer(guildId)`. Holds current track, queue, volume, pause state, and the voice/text channel bindings.
- **Node** — one Lavalink server connection. We run exactly one (`main`).
- **Lavalink** — standalone Java audio server (v4). Fetches, decodes, and streams audio to Discord; the bot only sends it commands.
- **youtube-source** — Lavalink plugin providing YouTube + YouTube Music support (v4 removed built-in YouTube).
- **LavaSrc** — Lavalink plugin resolving Spotify (and other) links to metadata, mirrored to YouTube for audio.
- **Mirroring** — playing a Spotify-identified track by finding its closest YouTube match (Spotify has no streaming API).
- **Search** — resolving a user query to tracks. URLs load directly. Plain text searches YouTube Music (`ytmsearch:`) and falls back to YouTube (`ytsearch:`) when that finds nothing. Internal lookups may also use `spsearch:` or `scsearch:`.
- **Announce channel** — the text channel where `/play` was invoked; receives the one "Now Playing" embed per track start.
- **Control command** — any command that mutates playback (`/skip`, `/stop`, `/volume`, `/shuffle`, `/pause`, `/resume`, `/skipto`). Requires invoker in the bot's voice channel.
- **Idle timeout** — 5-minute timer started when the queue empties or the voice channel becomes humanless; on expiry the player disconnects and is destroyed.
- **Sleep timer** — an in-memory, per-player control (`/sleep`) that ends the session like an intentional Stop after 1–720 minutes, or when the current track finishes (**stop after this track**, which also stops autoplay from continuing). It ends with its player.
- **Play** — one recorded start of a track in a server's voice channel, kept in the play statistics store. Records the **requester** (or that the bot queued it), how long it played, completion, and early skip. Never records who was listening.
- **Early skip** — a play ended by moving on (skip, jump, replacement) before 30 seconds or 40% of the track. Stopping, disconnecting, or a source failure is not an early skip.
- **Unattended pick** — a track queued by the bot user (radio, autoplay) rather than a person. Counts half in server favorites.
- **Song key** — the normalized same-song identity (`artist|title`) that groups topic uploads, official/lyric/audio videos, remasters, and feat. variants of one song. Live, remix, acoustic, and cover versions stay distinct.
- **Server favorites** — per-server lists built from visible plays: **On repeat** (rolling top 25, recency-decayed, repeat requests and early skips discounted) and **Forgotten gems** (popular 60–120 days ago, unplayed since). Queued with `/top play` or the portal's Play all/Shuffle.
- **Personal playlist** — a listener's generated playlist, computed on read from their request stats and favorites: **Your mix**, **Your top tracks**, **Rediscover**, and an **artist mix** for each of their top three artists. Queued with `/mymix play` or the portal's Home tab.
- **Your mix** — a blend of the listener's top requests (past 90 days) and favorites, lightly randomized with a seed that changes every Monday 00:00 UTC.
- **Server history** — the last 100 tracks that started in a server over 30 days, each with the voice channel it played in. Listeners see only entries from channels they can currently see.
- **Activity** — who changed a server's queue or settings in the last 24 hours (up to 200 entries). Favorites are never recorded.
- **Session checkpoint** — the saved queue, position, volume, pause and repeat state of a server's player, restorable for 72 hours after an outage or restart. Stop discards it.
- **Session mix** — a shared mix saved from the live session: songs already played, then the current song and queue (`/mix save session:true`, Save as mix on Stop).
- **Room taste** — autoplay taking turns between the listeners in the bot's voice channel who can hear it and haven't opted out (`/radio mytaste`), seeding each pick from one listener's requests and favorites (ADR-0012). Read at each pick; presence is never stored.
- **Request stats** — a listener's own requests: top tracks, top artists, and favorites not requested recently. "Clear my request stats" anonymizes them everywhere.
- **Android app** — a plain WebView shell over the live portal (ADR-0014, ADR-0016): native background playback, plus the listener's own YouTube Music library, signed in and read on their phone. The YouTube Music session never leaves the phone.
