### Vybertron Rework Plan

This plan reworks Vybertron into a robust, modern, deployable Discord music bot using Discord.js v14 and discord-player v6. It preserves the bot’s identity and intended features while improving stability, UX, and deployability.

## Goals
- Reliable slash-command based music bot with optional legacy prefix `!` support
- Stable audio playback via discord-player with YouTube support
- Clear responses with themed embeds and consistent error handling
- Easy command registration for dev (guild) and prod (global)
- One-command deploy (Heroku/Railway/Docker) with healthcheck

## Architecture
- `src/index.js`: Bootstrap client, intents, presence, event wiring
- `src/config.js`: Environment configuration for tokens, IDs, mode
- `src/player.js`: Player creation, extractor registration, and event hooks
- `src/commands/`: Self-contained command modules exporting `{ data, execute }`
- `src/commands/index.js`: Command loader and dispatcher for slash and `!`
- `src/utils/embeds.js`: Themed embed helpers for consistent responses
- `deploy-commands.js`: Command registration (guild for dev, global for prod)

## Features to Implement
- Core music: play, playnext, queue, skip, skipto, stop, volume
- Quality-of-life: nowplaying, pause, resume, shuffle
- Themed responses: embeds with Vybertron branding
- Autocomplete-ready structure for future enhancements

## Configuration
- `.env` keys:
  - `DISCORD_BOT_TOKEN`: bot token
  - `CLIENT_ID`: application client ID
  - `GUILD_ID` (optional for dev guild deploy)
  - `NODE_ENV`: `development` or `production`

## Command Registration
- Dev (guild-scoped, instant): `npm run deploy:commands:guild`
- Prod (global, may take up to 1 hour): `npm run deploy:commands:global`

## Deployment
- Keep existing `Procfile` for Heroku/Railway compatibility
- Add healthcheck via lightweight HTTP server (optional)
- Provide Dockerfile instructions (optional, future work)

## Implementation Steps
1. Add `src/config.js` for environment and mode handling
2. Improve `src/index.js` with presence, error logging, and loader calls
3. Enhance `src/player.js` with extractor registration and event messages
4. Add `src/utils/embeds.js` for themed responses
5. Refine `src/commands/index.js` and keep optional `!` support
6. Implement/refresh commands: play, playnext, queue, skip, skipto, stop, volume, nowplaying, pause, resume, shuffle
7. Replace `deploy-commands.js` to use v10 routes and env keys
8. Update `package.json` scripts and engines
9. Update `README.md` with fresh setup and usage docs

## Future Enhancements (Not in this rework)
- Lyrics, filters, autoplay toggle, seek, remove/move, pagination
- Persistent settings per guild
- Metrics and structured logging

