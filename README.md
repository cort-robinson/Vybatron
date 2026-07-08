## Vybertron

Vybertron is a Discord music bot that brings good vibes to your server. Inspired by the home world of the Transformers, Vybertron transforms your server into a musical haven.

### Features

- Play from YouTube with high reliability (discord-player v6)
- Queue management: playnext, skip, skipto, stop, shuffle
- Playback controls: pause, resume, volume, nowplaying
- Themed embed responses, optional legacy prefix `!`

### Requirements

- Node.js v18+
- Discord bot token and application client ID
- Lavalink server (Docker or Jar). Quick Docker example is below.

Create a `.env` file:

```env
DISCORD_BOT_TOKEN=your-bot-token
CLIENT_ID=your-app-client-id
# Optional for fast dev command deploy
GUILD_ID=your-dev-guild-id
NODE_ENV=development
# Optional: improve YouTube reliability by passing a logged-in cookie string
# Obtain from your browser devtools (Request headers Cookie) while on youtube.com
YT_COOKIE=__Secure-3PSID=...; __Secure-3PSIDCC=...; __Secure-3PAPISID=...; SAPISID=...; ...
```

Alternatively, you can run an interactive helper that opens a browser and saves the cookie to `.env` automatically:

```bash
npm run yt:get-cookie
```

### Install

```bash
npm install
```

### Commands

Slash commands (also available with `!` prefix where applicable):

- `/play <query>`
- `/playnext <query>`
- `/queue`
- `/skip`
- `/skipto <index>`
- `/stop`
- `/volume <0..100>`
- `/nowplaying`
- `/pause`
- `/resume`
- `/shuffle`

### Project Structure

```
.
├── src
│   ├── commands
│   │   ├── index.js
│   │   ├── nowplaying.js
│   │   ├── pause.js
│   │   ├── play.js
│   │   ├── playnext.js
│   │   ├── queue.js
│   │   ├── resume.js
│   │   ├── shuffle.js
│   │   ├── skip.js
│   │   ├── skipto.js
│   │   └── stop.js
│   ├── config.js
│   ├── index.js
│   ├── player.js
│   └── utils
│       └── embeds.js
├── deploy-commands.js
├── package.json
├── Procfile
├── REWORK_PLAN.md
```

## Step-by-step Setup (Development and Production)

### 1) Create and Configure Your Discord Application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click “New Application”, name it (e.g., Vybertron), and create.
3. In the left sidebar, go to “Bot” → “Add Bot”.
4. Copy the bot token and store it safely. You’ll put this in `DISCORD_BOT_TOKEN`.
5. Under “Privileged Gateway Intents”, enable:
   - Message Content Intent (required for legacy `!` prefix commands)
6. In the left sidebar, go to “OAuth2” → “URL Generator”:
   - Scopes: check `bot` and `applications.commands`
   - Bot Permissions: select at least `Send Messages`, `Embed Links`, `Connect`, `Speak`, `Use Slash Commands`
   - Copy the generated URL and open it to invite your bot to your server.

Your Application “General Information” page shows the Application ID. Use this as `CLIENT_ID`.

Optional for fast command registration during development: copy your server ID and set it as `GUILD_ID`.

### 2) Local Project Setup (Dev)

1. Clone the repo and install dependencies:
   ```bash
   git clone https://github.com/cort-robinson/Vybertron.git
   cd Vybertron
   npm install
   ```
2. Create a file named `.env` in the project root with:
   ```env
   DISCORD_BOT_TOKEN=your-bot-token
   CLIENT_ID=your-app-client-id
   GUILD_ID=your-dev-guild-id # optional but recommended for dev
   NODE_ENV=development
   ```
   Note: `.env` must be in the repository root (same folder as `package.json`).

### 3) Register Slash Commands

- Dev (guild-scoped, instant):
  ```bash
  npm run deploy:commands:guild
  ```
  Requires `GUILD_ID` in `.env`. New/updated commands appear immediately in that guild.

- Prod (global):
  ```bash
  npm run deploy:commands:global
  ```
  Global command propagation can take up to 1 hour. For faster iteration, use guild registration during development.

### 4) Run and Test Locally

1. Start the bot:
   ```bash
   npm start
   ```
2. In Discord:
   - Join a voice channel.
   - Use `/play <song or url>` to enqueue and start music.
   - Try other commands like `/queue`, `/skip`, `/pause`, `/resume`, `/shuffle`, `/volume 50`, `/nowplaying`.
   - Legacy prefix equivalents (e.g., `!play`) will work if Message Content Intent is enabled.

Troubleshooting:
- Slash commands missing: verify you invited the bot with `applications.commands` scope; register commands with the scripts above; for global, wait up to 1 hour.
- Prefix `!` not working: enable Message Content Intent in the Developer Portal and restart.
- Bot doesn’t join/speak: check it has Connect/Speak permissions and that you’re in a voice channel.

### 5) Lavalink Setup (Local or Remote)

Simplest: run Lavalink via Docker locally:

```bash
docker run -d \
  --name lavalink \
  -p 2333:2333 \
  -e SERVER_PORT=2333 \
  -e LAVALINK_SERVER_PASSWORD=youshallnotpass \
  ghcr.io/lavalink-devs/lavalink:4
```

Set the bot’s env to point to Lavalink (defaults already match above):

```env
LAVALINK_HOST=localhost
LAVALINK_PORT=2333
LAVALINK_PASSWORD=youshallnotpass
```

Alternatively, deploy Lavalink on a VPS or in Docker on your host of choice.

### 6) Production Deployment Options

You can deploy Vybertron anywhere that can run Node 18+ continuously. Below are tested, simple options.

#### Option A: Heroku (or Heroku-compatible)

The repo includes a `Procfile` with a worker process:

```
worker: node src/index.js
```

Steps:
1. Install the [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli) and log in.
2. From the repo root:
   ```bash
   heroku create vybertron
   heroku git:remote -a vybertron
   ```
3. Set config vars (environment variables):
   ```bash
   heroku config:set DISCORD_BOT_TOKEN=your-bot-token CLIENT_ID=your-app-client-id NODE_ENV=production
   # GUILD_ID is optional in prod
   ```
4. Deploy:
   ```bash
   git push heroku main
   ```
5. Scale the worker dyno:
   ```bash
   heroku ps:scale worker=1
   ```
6. View logs:
   ```bash
   heroku logs -t
   ```
7. Register slash commands globally (run locally or via one-off dyno):
   ```bash
   npm run deploy:commands:global
   ```

Notes:
- If using a different default branch, push that branch instead of `main`.
- If you see version issues, ensure `engines.node` in `package.json` is respected (Node 18+).

#### Option B: Railway

1. Go to [Railway](https://railway.app/) and create a new project from this GitHub repo.
2. Add the following environment variables in the service settings:
   - `DISCORD_BOT_TOKEN`, `CLIENT_ID`, `NODE_ENV=production` (and optionally `GUILD_ID`)
3. Railway will detect Node and run `npm start`. If needed, set the start command to `node src/index.js`.
4. After deploy, register global commands from your local machine:
   ```bash
   npm run deploy:commands:global
   ```

#### Option C: Render

1. Create a new [Render](https://render.com/) “Background Worker”.
2. Set the Start Command to:
   ```
   node src/index.js
   ```
3. Add environment variables: `DISCORD_BOT_TOKEN`, `CLIENT_ID`, `NODE_ENV=production` (optional `GUILD_ID`).
4. Deploy, then register global commands locally:
   ```bash
   npm run deploy:commands:global
   ```

### 7) Security and Best Practices

- Never commit `.env` or your bot token. Treat it like a password.
- Revoke/regenerate the token immediately if it leaks.
- Prefer guild-scoped command deploys while iterating; switch to global once stable.

### License

MIT

### Acknowledgements

- [discord.js](https://discord.js.org/)
- [discord-player](https://discord-player.js.org/)
