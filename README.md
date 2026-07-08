# Vybertron

Vybertron is a Discord music bot that brings good vibes to your server. Inspired by the home world of the Transformers, Vybertron transforms your server into a musical haven.

Powered by [Lavalink v4](https://lavalink.dev/) with [discord.js](https://discord.js.org/) and [lavalink-client](https://github.com/tomato6966/lavalink-client).

## Features

- Plays YouTube and YouTube Music links, searches, and playlists (via the [youtube-source](https://github.com/lavalink-devs/youtube-source) plugin)
- Spotify track/album/playlist links, mirrored to YouTube (via [LavaSrc](https://github.com/topi314/LavaSrc))
- SoundCloud playback
- Queue management: `/playnext`, `/skip`, `/skipto`, `/stop`, `/shuffle`
- Playback controls: `/pause`, `/resume`, `/volume`, `/nowplaying`
- Control commands require you to be in the bot's voice channel
- Auto-disconnects after 5 minutes idle or when the voice channel empties

## Commands

| Command | Description |
|---|---|
| `/play <query>` | Play a song/playlist (URL or search) |
| `/playnext <query>` | Add a song to the front of the queue |
| `/queue` | Show the current queue |
| `/skip` | Skip the current track |
| `/skipto <index>` | Jump to a queue position |
| `/stop` | Clear queue and disconnect |
| `/volume <0-100>` | Set volume |
| `/nowplaying` | Show current track |
| `/pause` / `/resume` | Pause / resume |
| `/shuffle` | Shuffle the queue |

## Setup

### 1. Discord application

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications).
2. Bot tab → copy the bot token (`DISCORD_BOT_TOKEN`).
3. General Information → copy the Application ID (`CLIENT_ID`).
4. OAuth2 → URL Generator: scopes `bot` + `applications.commands`; permissions `Send Messages`, `Embed Links`, `Connect`, `Speak`. Invite the bot with the generated URL.

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
