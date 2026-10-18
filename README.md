# Vybatron v2

A shared soundtrack for Discord, with a player that stays out of the way and an audio stack that knows how to recover.

## What is new

- **Stream recovery:** fresh track resolution, bounded retries, stale-event protection, source circuit breakers, and a watchdog that checks real server-reported progress.
- **Voice recovery:** complete gateway handshakes in either event order, resumable audio sessions, and fresh Discord voice credentials when a session cannot resume.
- **Your music:** personal favorites, shared server mixes, recent history and replay, and explicit session restore after a restart.
- **Server favorites:** On repeat and Forgotten gems lists built from what your server actually plays, queued in one action with `/top play` or the portal.
- **Personal playlists:** Your mix (new picks every Monday), Your top tracks, Rediscover and a mix for each of your top three artists, built from your own requests and favorites and queued with `/mymix play` or the portal's Home tab.
- **Web portal:** Discord sign-in, a live shared queue, an expanding artwork player, private favorites and server management on desktop or phone. Audio continues in Discord.
- **Listen together:** optional fair queue, majority vote skip, a DJ role, and server volume defaults.
- **Make it sound right:** Original, Bass, Warm, Clarity, Nightcore, Slow, and Mono presets. Each preset replaces previous effects.
- **Keep the music going:** smart autoplay plays related songs from YouTube's "up next" mix after the human-requested queue runs out. Seeds drift with what's been playing, recent server plays and near-duplicates are skipped, and skipping a pick plays less like it. Servers choose off, on, or on only while someone is listening; `/radio` overrides it for a session.
- **One shared player:** artwork, progress, speed-aware timing, recovery state, Favorite, queue browsing, Seek, and confirmed Stop. Private confirmations keep the channel quiet.
- **Reliable operations:** durable atomic library writes, a non-root container, bounded memory/logs, graceful shutdown, health diagnostics, and exact-commit deployment with rollback.

Powered by [Lavalink](https://lavalink.dev/), [discord.js](https://discord.js.org/), and [lavalink-client](https://github.com/tomato6966/lavalink-client). Lavalink remains the only audio engine and its player queue remains the only live queue.

## Sources

| Input | Behavior |
| --- | --- |
| YouTube / YouTube Music | Song searches, catalog links, and playlists |
| Spotify | Public track, album, and playlist catalog links matched to playable recordings |
| SoundCloud | Public track and playlist links |
| Bandcamp | Public track and album links supported by the audio server |

Spotify is a catalog import, not a Spotify audio stream. If native catalog lookup is unavailable, the bot reads public Spotify embeds and conservatively matches title, artist, version, and duration to YouTube Music/YouTube results. It never uses embed credentials, cookies, or preview audio. Public collections may expose only part of a playlist: imports are limited to 100 displayed tracks and report unmatched or remaining displayed entries. Private, removed, region-restricted, and unmatched recordings can remain unavailable. Source lookup success alone does not prove audio delivery.

## Commands

Start with `/help`. Join a voice channel and use `/play` with a song and artist, a fresh autocomplete result, or a supported public HTTPS link.

| Command | Purpose |
| --- | --- |
| `/invite` | Bot owner and portal operators: get a link to add Vybatron to another server |
| `/play`, `/playnext` | Add music or request the next track |
| `/queue`, `/remove`, `/move`, `/clear` | Browse and edit upcoming tracks; Clear keeps the current song playing |
| `/back`, `/skip`, `/skipto`, `/voteskip` | Go back a track (or restart this one), skip, jump, or vote with a strict majority of current human listeners |
| `/pause`, `/resume`, `/seek`, `/stop` | Transport controls; Stop clears and disconnects |
| `/volume`, `/loop`, `/shuffle`, `/nowplaying` | Volume, repetition, queue order, and player details |
| `/filter` | Inspect or select an audio preset |
| `/favorite add/list/play/remove/clear` | Global private favorites across supported servers; Clear requires confirmation |
| `/mix save/list/load/delete` | Save up to 100 tracks in a shared mix; owner or server manager can change it. `session:true` also keeps songs already played this session |
| `/history`, `/replay` | Browse recent tracks and queue one to replay next |
| `/top show/play` | Browse or queue this server's favorites: On repeat or Forgotten gems, optionally shuffled |
| `/mymix show/play` | Browse or queue your personal playlists: Your mix, top tracks (with a time range), Rediscover, or an artist mix |
| `/radio on [track]/off` | Turn autoplay on or off for this session; `track` starts it from a chosen song or link |
| `/radio promote/remove/less <position>` | Move a suggestion into the queue (any listener in voice; it stays an autoplay pick), remove it, or hear less like it; `/radio less` without a position skips the current autoplay pick |
| `/session show/resume/discard` | Preview or explicitly restore a checkpoint kept for 72 hours |
| `/settings show/volume/fairqueue/autoplay/djrole/musicchannel/reset` | Server defaults and portal controller channel; requires server owner or Manage Server |

Controls require the bot's voice channel and honor a configured DJ role. Listeners can still add music, save personal favorites, and vote to skip. Voice access is checked again when a long import finishes. Favorites hold 1,000 tracks per account, shared mixes hold 100 tracks each with 25 mixes per server, and the upcoming queue holds 500 tracks. Migrated favorite overflow is retained and returns to the active shelf as space opens. Played history retains the latest 100 tracks per server for up to 30 days, with original channel visibility enforced. Server favorites count plays from the past year (up to 10,000 per server) and show each person only plays from voice channels they can see. Repeat requests by one person and early skips count less. Personal playlists use only your own requests in channels you can see (artist mixes add anonymous server plays by that artist) and are computed when you ask, so clearing your request stats empties them at once. The Stop confirmation offers Save as mix, which keeps the session's played songs, current song and queue as a shared mix.

The bot leaves after five minutes with an empty queue, or one minute after the last listener leaves its voice channel. It never automatically rejoins a saved voice session at startup; `/session resume` requires joining the saved channel. An intentional Stop discards that session checkpoint. Favorites and mixes survive Stop and container rebuilds.

## Setup

Use Node **24.11 or newer** for native development (play statistics use the built-in `node:sqlite` module); the Docker runtime is pinned to Node 24. The Compose stack includes the bot, Lavalink 4.2.2, YouTube cipher service, and WARP. The audio images and YouTube plugin are pinned to the stack verified for this release.

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Invite it with `bot` and `applications.commands` scopes. Grant View Channel, Send Messages, Embed Links, Connect, and Speak. Set Voice Channel Status is optional. Keep **Public Bot** off so only you can add it. After the first install, `/invite`, `/help`, and the portal offer this same link to you and to `PORTAL_OPERATOR_IDS` only; everyone else is told to ask you.
3. Create `.env` at the repository root:

```env
DISCORD_BOT_TOKEN=your-bot-token
CLIENT_ID=your-application-id
LAVALINK_PASSWORD=choose-a-strong-password
# Optional: instant registration in a test server
GUILD_ID=your-test-server-id
# Optional: authenticated YouTube playback
YOUTUBE_REFRESH_TOKEN=your-refresh-token
```

The bot uses the Guilds, GuildVoiceStates and privileged GuildMembers intents. Enable **Server Members Intent** for the application in the Discord Developer Portal before starting it, or login fails. Keep `.env` private and out of Git. Spotify public embed imports require no Spotify account or credential.

```bash
docker compose up -d --build
# Production catalog:
docker compose run --rm bot npm run deploy:commands:global
```

For instant registration in a test server through Compose, provide `GUILD_ID` explicitly:

```bash
docker compose run --rm -e GUILD_ID=your-test-server-id bot npm run deploy:commands:guild
```

For native development, publish the audio port on the **warp** service in a local Compose override, keep its access private, then use `npm ci`, `npm start`, and the command-registration scripts. The normal stack keeps Lavalink inside the Compose network.

## Saved music

Compose mounts `bot-data` at `/app/data`. The library contains public catalog references and server/user IDs needed for ownership; it never saves audio, encoded tracks, cookies, or bot/provider tokens. Sources are freshly resolved when loading saved music. Failed writes leave the previous library intact, and invalid persisted data stops startup instead of silently replacing it.

Play statistics are kept separately in `stats.sqlite` next to the library: server, song, voice channel, time, who requested it (or that the bot queued it), and whether it finished or was skipped early. Who was merely listening is never recorded. The store is bounded to one year, 10,000 plays per server and 16 MiB, and imports existing history once. If it cannot be opened or written, playback continues and stats show as unavailable; the file is left in place for inspection. Listeners can clear their own request stats from the portal API, which anonymizes their requests everywhere.

Back up `bot-data` before moving the VPS. Normal rebuilds preserve it; deleting the volume removes favorites, mixes, settings, checkpoints, and play statistics. Native mode uses `data/library.json`; set an absolute `VYBERTRON_DATA_DIR` to change it.

## Web portal

The optional portal uses the existing player and music store. Server members can
browse permitted sessions and use their allowed music controls. Server owners,
Manage Server members and the verified bot maintainer can manage configuration;
playback still follows voice and DJ rules. Sign-in lasts seven days per device.

Home is the landing view: Continue listening (the live or saved session and recent songs), On repeat in this server, Your mixes, Rediscover and Forgotten gems, each with Play, Shuffle or Add, then a Listening recap (your requests and the server's plays over a chosen week, month, three months or year, with played time and top tracks and artists) and Clear my request stats. The queue view has one persistent player that expands into an artwork view.
Artwork colors and subtle aurora motion set the atmosphere; motion can be reduced
or disabled. The installable PWA supports desktop and phone, retains typed search
input when disconnected, and waits for fresh state before enabling controls.

Read the [portal operations runbook](docs/portal-operations.md) for private
provisioning, free HTTPS hosting, exact-source deployment and rollback. The
portal bridge stays inside Docker; only the bounded auth/API service is exposed.
Never put the OAuth secret or internal bridge token in the web build. Library
migration creates an exact private v1 backup before replacing the data file.

For local development, install dependencies in the root, `portal/server` and
`portal/web`. Provision private environment values from `.env.portal.example`,
run the API with `node portal/server/src/index.js`, and use `npm run portal:dev`.
The development proxy origin must match `PORTAL_ORIGIN`. Verify with
`npm run portal:build`, `npm run portal:test`, `npm --prefix portal/web test` and
`npm run portal:integration` (Playwright Chromium required).

## Recovery and releases

See the [operations runbook](ops/README.md) for canaries, maintenance, bounded service repair, and rollback. Readiness checks Discord plus the audio connection; decoded canaries check source audio; a human listening test checks Discord delivery. These are separate checks.

WARP and the audio services share a network namespace. If the WARP container needs replacement, recreate its audio dependents together under the maintenance lock; restarting WARP alone can strand them in its old namespace. Keep `warp-data` to retain registration.

The optional GitHub deployment workflow activates only with `DEPLOY_ENABLED=true` and `VPS_HOST`, `VPS_HOST_KEY`, `VPS_USER`, and `VPS_SSH_KEY` secrets. It deploys the exact successful main-push CI commit and the images that CI tested, waits for an idle queue, preserves the running audio image IDs, decodes two full canaries, registers the complete command catalog, and verifies bot readiness. A durable journal retains the previous commit, config, images, and command catalog for rollback. Merging to main can deploy when that gate is enabled.

## Verification

```bash
npm ci
npm test
npm audit --omit=dev --audit-level=high
python3 -m unittest discover -s tests -p '*_test.py'
bash tests/warp-supervisor.test.sh
```

CI also builds the container, verifies non-root persistence on a read-only filesystem, and validates Compose. Recovery tests exercise the pinned client's real event and player behavior, including late events, voice event ordering, pause/seek, and resumed sessions.

Code map: `src/commands` defines the slash commands and `deploy-commands.js` validates and registers the same catalog. `src/playback-recovery.js` adapts the pinned lavalink-client SDK and `src/playback-watchdog.js` checks progress. `src/utils/library.js` persists favorites and mixes, `src/utils/sessions.js` session checkpoints, and `src/utils/play-stats.js` play statistics (with `play-tracking`, `song-identity`, `stats-scoring` and `auto-playlists` alongside). `src/portal` is the private portal bridge. `ops/recovery.py` probes sources and performs bounded repairs; `ops/deploy.py` owns release transactions and rollback.

Design decisions and terms are in [docs/adr](docs/adr) and [docs/GLOSSARY.md](docs/GLOSSARY.md). The manual listening check before a release is in the [operations runbook](ops/README.md#manual-listening-check).

MIT license.
