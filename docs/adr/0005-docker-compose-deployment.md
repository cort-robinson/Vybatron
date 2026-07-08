# ADR-0005: docker-compose runs bot + Lavalink together

- Status: Accepted
- Date: 2026-07-08

## Context

The bot will run on a local machine for now, with a stated desire to move to a VPS or PaaS later without rework. Lavalink is a separate Java service that must run alongside the bot.

## Decision

A single `docker-compose.yml` at repo root defines two services:

- `lavalink`: `ghcr.io/lavalink-devs/lavalink:4`, with `application.yml` mounted (or configured via environment) declaring the youtube-source and LavaSrc plugins. Not exposed publicly; internal network only.
- `bot`: Node 20+ image built from a repo `Dockerfile`, `depends_on` lavalink, connects via the compose service hostname (`LAVALINK_HOST=lavalink`).

Secrets (`DISCORD_BOT_TOKEN`, `CLIENT_ID`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `LAVALINK_PASSWORD`) come from `.env`, which docker-compose reads natively.

`docker compose up -d` is the entire local run story, and the identical file works on any Docker-capable VPS — satisfying the portability goal. The Heroku `Procfile` remains for now but is no longer the primary path.

## Consequences

- Local dev iteration can still run the bot natively (`npm start`) against the composed Lavalink (`docker compose up lavalink`), since `LAVALINK_HOST` defaults to `localhost`.
- Plugin version bumps (e.g., youtube-source fixes) are config-only changes in the Lavalink service.
- PaaS deploys later mean pointing `LAVALINK_HOST` at a hosted/side-car Lavalink; no bot code changes.
