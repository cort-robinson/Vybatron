# Vybertron

Vybertron is a Discord music bot that brings good vibes to your server. Inspired by the home world of the Transformers, Vybertron transforms your server into a musical haven.

Powered by [Lavalink v4](https://lavalink.dev/) with [discord.js](https://discord.js.org/) and [lavalink-client](https://github.com/tomato6966/lavalink-client).

## Features

- Plays YouTube and YouTube Music links, searches, and playlists (via the [youtube-source](https://github.com/lavalink-devs/youtube-source) plugin)
- Spotify track/album/playlist links, mirrored to YouTube (via [LavaSrc](https://github.com/topi314/LavaSrc))
- SoundCloud playback
- Queue management: `/playnext`, `/skip`, `/skipto`, `/remove`, `/move`, `/stop`, `/shuffle`
- Playback controls: `/pause`, `/resume`, `/volume`, `/loop`, `/nowplaying`
- Persistent player controls with live end time, requester, queue, loop, and confirmed stop actions
- Voice channel status shows the current track when permission is available
- Control commands require you to be in the bot's voice channel
- Auto-disconnects after 5 minutes idle or when the voice channel empties

## Commands

| Command | Description |
|---|---|
| `/play <query>` | Play a song/playlist (URL or search) |
| `/playnext <query>` | Add a song to the front of the queue |
| `/queue` | Show the paginated current queue |
| `/remove <position>` | Remove an upcoming queue track |
| `/move <from> <to>` | Move an upcoming track to a final queue position |
| `/skip` | Skip the current track |
| `/skipto <index>` | Jump to a queue position |
| `/stop` | Clear queue and disconnect |
| `/volume <0-100>` | Set volume |
| `/nowplaying` | Show current track |
| `/pause` / `/resume` | Pause / resume |
| `/shuffle` | Shuffle the queue |
| `/loop <off\|track\|queue>` | Set the loop mode |

## Setup

### 1. Discord application

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications).
2. Bot tab → copy the bot token (`DISCORD_BOT_TOKEN`).
3. General Information → copy the Application ID (`CLIENT_ID`).
4. OAuth2 → URL Generator: scopes `bot` + `applications.commands`; permissions `Send Messages`, `Embed Links`, `Connect`, `Speak`, `Set Voice Channel Status`. Invite the bot with the generated URL.

`Set Voice Channel Status` is optional. Without it, playback and controls still work; only the `🎵 Track — Artist` channel status is omitted.

No privileged intents are required.

### 2. Spotify credentials (optional, for Spotify links)

Create a free app at [developer.spotify.com](https://developer.spotify.com/dashboard) and copy its client ID and secret.

### 3. Environment

Create `.env` at the repo root:

```env
DISCORD_BOT_TOKEN=your-bot-token
CLIENT_ID=your-app-client-id
LAVALINK_PASSWORD=pick-a-strong-password
# Optional: instant command registration in one dev server
GUILD_ID=your-dev-guild-id
# Optional: Spotify link support
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
```

### 4. Run

**Everything in Docker** (recommended, works identically on a VPS):

```bash
docker compose up -d --build
```

**Dev mode** (bot native for fast iteration, Lavalink in Docker):

```bash
docker compose up -d lavalink
npm install
npm start
```

### 5. Register slash commands

```bash
# Dev: instant, one guild (needs GUILD_ID)
npm run deploy:commands:guild

# Prod: global (propagation can take up to 1 hour)
npm run deploy:commands:global
```

## Deploying to a VPS (CI/CD)

CI runs tests + a Docker build on every PR and push to `main`. Merges to `main` auto-deploy to a VPS over SSH once enabled.

One-time VPS setup (any Docker-capable box — Hetzner, DigitalOcean, Oracle free tier):

```bash
curl -fsSL https://get.docker.com | sh
git clone https://github.com/cort-robinson/Vybertron && cd Vybertron
# create .env (see above), then:
docker compose up -d
```

Enable auto-deploy in the GitHub repo settings:

1. **Secrets** (Settings → Secrets and variables → Actions → Secrets): `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (private key whose public half is in the VPS `~/.ssh/authorized_keys`).
2. **Variable**: `DEPLOY_ENABLED` = `true`.

Until `DEPLOY_ENABLED` is set, the deploy workflow stays dormant — CI still runs.

### YouTube on a VPS ("This video requires login")

YouTube blocks anonymous playback from datacenter IPs. One-time fix with a **throwaway** Google account:

1. Start the stack; watch `docker logs -f vybertron-lavalink` for an OAuth prompt with a `google.com/device` code.
2. Open [google.com/device](https://google.com/device), sign in with the throwaway account, enter the code.
3. The log then prints a refresh token — add it to `.env` as `YOUTUBE_REFRESH_TOKEN=...` and `docker compose up -d --force-recreate lavalink`.

## Tests

```bash
npm test
```

## Project structure

```
.
├── src
│   ├── commands/          # one module per slash command ({ data, execute })
│   ├── utils/             # embeds, voice-channel guards
│   ├── config.js          # env config + startup assertions
│   ├── lavalink.js        # LavalinkManager wiring, announce + idle logic
│   └── index.js           # client bootstrap
├── lavalink/application.yml   # Lavalink server + plugin config
├── docker-compose.yml     # bot + lavalink services
├── deploy-commands.js     # slash command registration
└── docs/                  # ADRs and glossary
```

Design decisions are recorded in [docs/adr](docs/adr); domain terms in [docs/GLOSSARY.md](docs/GLOSSARY.md). The living spec is [SPEC.md](SPEC.md).

## Security notes

- Never commit `.env` or your bot token; regenerate the token immediately if it leaks.
- The Lavalink port is not published to the host; it is only reachable on the compose network. If you expose it, use a strong `LAVALINK_PASSWORD`.

## License

MIT
