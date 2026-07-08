# Vybertron SPEC

## §G goal

Discord music bot. Slash commands only. Plays YouTube + YT Music + Spotify (mirrored) + SoundCloud, incl. playlists. Lavalink v4 backend. docker-compose local, portable to VPS.

## §C constraints

- Node ≥18, ESM (`"type": "module"`)
- discord.js v14, slash register via `@discordjs/rest` v10 routes
- Audio engine: Lavalink v4 only, client lib `lavalink-client` [ADR-0001, ADR-0002]
- Sources server-side: `youtube-source` plugin (YT+YTM), `LavaSrc` plugin (Spotify mirror), built-in SoundCloud [ADR-0004]
- Intents: Guilds, GuildVoiceStates only. ⊥ MessageContent [ADR-0003]
- Deploy: docker-compose (bot + lavalink services) [ADR-0005]
- Secrets ∈ `.env`, ⊥ commit
- Terms per docs/GLOSSARY.md

## §I interfaces

```
cmd: /play <query>        → enqueue (playlist → all tracks, reply count) + start
cmd: /playnext <query>    → insert front of queue
cmd: /queue               → list tracks
cmd: /skip                → next track
cmd: /skipto <index>      → jump to index
cmd: /stop                → clear queue + disconnect now
cmd: /volume <0..100>     → set volume (default 100, no persist)
cmd: /nowplaying          → current track embed
cmd: /pause | /resume     → toggle playback
cmd: /shuffle             → shuffle queue
cli: docker compose up -d             → full stack (bot + lavalink)
cli: npm start                        → bot native (dev; lavalink via compose)
cli: npm run deploy:commands:guild    → guild register (needs GUILD_ID)
cli: npm run deploy:commands:global   → global register
ci: .github/workflows/ci.yml          → PR + main push: npm test, docker build, compose config
cd: .github/workflows/deploy.yml      → main push, gated on repo var DEPLOY_ENABLED=true: SSH to VPS, git pull, compose up --build
cd-secrets: VPS_HOST | VPS_USER | VPS_SSH_KEY ! set in repo secrets before enabling
env: DISCORD_BOT_TOKEN ! set
env: CLIENT_ID ! set
env: GUILD_ID ? (guild deploy only)
env: LAVALINK_HOST ? default localhost (compose: lavalink)
env: LAVALINK_PORT ? default 2333
env: LAVALINK_PASSWORD ! set
env: SPOTIFY_CLIENT_ID | SPOTIFY_CLIENT_SECRET ! set (LavaSrc)
mod: src/config.js          → config + assertConfig() (throw on missing required)
mod: src/lavalink.js        → LavalinkManager wiring + events
mod: src/commands/<name>.js → export { data, execute }
mod: src/utils/embeds.js    → successEmbed|errorEmbed|infoEmbed
```

## §V invariants

V1: ∀ command file → export `data` & `execute`, else warn + skip
V2: missing required env → throw at startup, ⊥ silent run
V3: ∀ voice command → user ∈ voice channel, else reject reply
V4: ∀ command error → caught, user gets reply, ⊥ unhandled crash
V5: event embed sends → `.catch(() => {})`, send failure ⊥ crash bot
V6: guild deploy without GUILD_ID → throw
V7: one queue ∀ commands — lavalink-client `player.queue` sole state, ⊥ second engine
V8: ∀ control command (skip|stop|volume|shuffle|pause|resume|skipto) → invoker ∈ bot's voice channel, else reject
V9: queue empty | voice channel humanless → 5 min idle timer → disconnect + destroy player
V10: track start → exactly 1 "Now Playing" embed; ⊥ track-end messages; ⊥ autoplay
V11: ∀ plugin version pinned in lavalink/application.yml ! exist on maven.lavalink.dev (verify maven-metadata.xml before pin)

## §T tasks

id|status|task|cites
T1|x|purge deps: drop discord-player stack, vulkava, ytdl*, play-dl, puppeteer, opus/ffmpeg, node-wit; keep discord.js, dotenv, lavalink-client|V7,ADR-0001
T2|x|delete src/player.js, scripts/get-yt-cookie.mjs, YT_COOKIE config|ADR-0001
T3|x|rewrite src/lavalink.js: LavalinkManager, sendRawData wiring, trackStart announce, idle timer|V5,V9,V10,ADR-0002
T4|x|src/config.js: add LAVALINK_*, SPOTIFY_*; drop ytCookie|V2
T5|x|rewrite all 11 commands on lavalink-client player/queue|V3,V4,V7
T6|x|voice-channel guard helper + apply to control commands|V8
T7|x|delete prefix shim + messageCreate handler; trim intents|ADR-0003
T8|x|lavalink/application.yml: youtube-source + LavaSrc plugins, Spotify creds via env|ADR-0004
T9|x|Dockerfile + docker-compose.yml (bot + lavalink)|ADR-0005
T10|x|update README: new setup, env table, compose instructions; delete stale YT_COOKIE/prefix docs|§G
T11|x|smoke test: /play YT link, YTM link, Spotify link, SC link, playlist; /skip /queue /stop|V7,V8
T12|.|re-verify Spotify links when upstream LavaSrc/spotify-tokener ship token fix (`docker compose pull`, retest REST loadtracks)|B2
T13|x|CI workflow: npm test + docker build + compose config validate on PR & main|V1-V11,§I.ci
T14|x|CD workflow: SSH deploy to VPS on main push, dormant until DEPLOY_ENABLED var set|§I.cd
T15|.|provision VPS (user picks Oracle free / Hetzner), add repo secrets, set DEPLOY_ENABLED=true|T14

## §B bugs

id|date|cause|fix
B1|2026-07-08|pinned youtube-plugin 2.1.4 from doc snippet, version ∉ maven repo, Lavalink boot `FileNotFoundException`|V11
B2|2026-07-08|Spotify anonymous-token ecosystem broken upstream (scraper "No secret array found", tokener CDP -32000, 429 throttle); spDc lyrics-only, ⊥ track lookup|T12 wait upstream
