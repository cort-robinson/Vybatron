# ADR-0002: lavalink-client as the Node client library

- Status: Accepted
- Date: 2026-07-08

## Context

Both `vulkava` and `lavalink-client` are in package.json; only vulkava is wired (partially, in `src/lavalink.js`). We need one client library to talk to Lavalink v4.

Candidates:
- **vulkava** — already partially wired, but less actively maintained and weaker Lavalink v4 support.
- **lavalink-client** (tomato6966) — actively maintained, first-class Lavalink v4 support, built-in per-guild queue, plugin-aware (LavaSrc query sources), `autoSkip` handling.
- **shoukaku** — solid but minimal; no built-in queue, we would write our own queue layer.

## Decision

Use `lavalink-client`. Remove `vulkava`. The built-in queue becomes the single source of truth for all commands, which directly fixes the split-brain defect (SPEC §V7).

Core wiring (verified against current docs):

```js
const lavalink = new LavalinkManager({
  nodes: [{ authorization, host, port, id: "main" }],
  sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
  autoSkip: true,
  client: { id: clientId },
});
client.on("raw", (d) => client.lavalink.sendRawData(d));
client.on("ready", () => client.lavalink.init({ ...client.user }));
```

## Consequences

- `src/lavalink.js` is rewritten around `LavalinkManager`; all commands read/write `lavalink.getPlayer(guildId)` and its `player.queue`.
- Idle disconnect (ADR-0004 behavior decisions) uses the library's player/queue-end events plus a 5-minute timer.
- Search prefixes (`ytsearch`, `ytmsearch`, `spsearch`, `scsearch`) come free once LavaSrc/youtube-source are configured server-side.
