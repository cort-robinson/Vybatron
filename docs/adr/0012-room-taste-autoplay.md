# ADR-0012: Autoplay takes turns between the listeners in the room

- Status: Accepted
- Date: 2026-10-27
- Amends: [ADR-0006](0006-play-statistics-store-and-song-identity.md) ("Listeners merely
  present in voice are never read") and the seed rules of [ADR-0008](0008-smart-autoplay.md)

## Context

Smart autoplay (ADR-0008) seeds YouTube mixes from the room's last few plays. It follows
what is playing but not who is listening, so a friend who joins hears the same drift as
before, and two people with different taste get whichever one queued last.

The bot already knows who is in its voice channel (the `listening` autoplay mode reads it)
and each listener's taste: their requests in the play statistics store (ADR-0006) and their
favorites, the same inputs as Your mix (ADR-0007). ADR-0006 promised that listeners merely
present in voice are never read or stored. Using presence to choose whose taste shapes a
pick reads it, so that promise changes here. Nothing about presence is stored.

The owner chose room taste on by default, with a per-listener opt-out.

## Decision

**Who counts.** At each pick, the listeners are the people in the bot's voice channel who
are not bots, not deafened, and have not opted out, at most ten, in channel order. Someone
with no requests or favorites in scope is left out of that pick.

**Taste per listener.** Read on every pick, never cached or stored:

- up to 10 of their most requested songs in this server over 90 days, early skips excluded;
- up to 10 of their newest favorites (favorites are global, as in Your mix);
- their top artists, and the songs they skipped early in this server over 30 days.

Requests and skips count only from voice channels **every person present** can view,
including people who opted out or are deafened, so a pick never draws on a channel hidden
from someone hearing it.

**Taking turns.** Each pick belongs to the present listener with the fewest picks this
session, then the one who waited longest. A listener new to the session starts level with
the least-served person present and goes next. That listener's seeds rotate, with songs that
another present listener also requested or saved first. Their seed is tried first, then
the room's recent plays (ADR-0008), so the station still follows what is playing. A "Start
radio" song still leads its first picks.

**Shared taste first.** Mix results by an artist that two or more present listeners like move
ahead of the rest; otherwise the mix's relevance order is kept. A present listener's early
skips are filtered out of every pick while they are in the room.

**Presence changes.** Suggestions remember whom they were picked for, in memory only. Before
a suggestion is used, picks for anyone who left, deafened or opted out are dropped. If
someone new to the session is present, the buffer is cleared so they get the next pick.

**Unchanged.** Human queue first, the three-suggestion buffer, filters, "less like this",
bounds and failure handling are as in ADR-0008. Picks are still queued by the bot user. A
taste seed takes strikes and retires like any other seed. Without stats, listeners or history,
autoplay behaves exactly as before.

**Opt-out.** `/radio mytaste enabled:False` or the portal's Settings → "Autoplay uses my taste"
switch. It applies in every server. The library stores only opt-outs (`tasteOptOut` in
`library.json`), so everyone else is on by default, and opting back in removes the entry.
Clearing request stats removes a listener's requests from their taste at the next pick.

**No labels.** Picks are not labeled with whose turn it was. People in the room may still
infer a listener's taste from the picks; the opt-out exists for that.

## Consequences

- ADR-0006's "Listeners merely present in voice are never read or stored" now reads: never
  stored; read only to choose room autoplay seeds while autoplay runs.
- Each pick costs a few indexed SQLite reads per present listener (at most ten listeners).
- Older bots ignore `tasteOptOut`, so a rollback keeps working and forgets opt-outs until
  the newer release returns.
- The portal bootstrap gains `viewer.autoplayTaste`, with a new preference endpoint (see
  `docs/portal-contract.md`). `/radio mytaste` is a new subcommand in the command catalog.
