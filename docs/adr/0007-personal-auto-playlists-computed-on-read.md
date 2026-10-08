# ADR-0007: Personal auto-playlists are computed on read

- Status: Accepted
- Date: 2026-10-08

## Context

The portal's Home tab and `/mymix` offer each listener generated playlists: Your mix, Your top
tracks, Rediscover, and a mix for each of their top three artists. They draw on the play
statistics store ([ADR-0006](0006-play-statistics-store-and-song-identity.md)) and the
listener's global favorites. They must refresh on their own, and Your mix should feel fresh
weekly without reshuffling every time the page loads.

The two options were a cached playlist per listener and server, rotated weekly, or computing
each playlist when it is asked for.

## Decision

**Compute on read.** `src/utils/auto-playlists.js` builds every playlist from current data on
each stats read or `/mymix` request. Nothing new is stored.

- The inputs are small and indexed: at most 10,000 plays per server and 1,000 favorites per
  listener, read through the existing `requester_id` and `guild_id` indexes. Building all
  playlists is a handful of SQLite queries, well inside the stats endpoint's existing cost.
- Privacy follows automatically. "Clear my request stats" and removing a favorite take effect on
  the next read; a cache would be a second copy of someone's listening needing its own
  retention, invalidation and clearing rules.
- Visibility follows automatically. Lists use only plays in voice channels the viewer can see
  right now, so a channel hidden later stops contributing at once.

**Weekly stability without storage.** Your mix uses a seed of listener, server and UTC week
(weeks start Monday 00:00 UTC). Each song's jitter and position come from hashing the seed with
that song's key, not its list position, so the mix holds its picks and order all week even as
the inputs shift slightly, and turns over on Monday. The response carries `refreshesAt`.

**Composition.**

- Your mix: about 60% the listener's top requests from the past 90 days (rank-weighted with
  light jitter), the rest favorites sampled by the weekly seed, each song once. Whatever one
  source lacks, the other fills. Up to 25 tracks.
- Your top tracks: the listener's most requested songs in the chosen window (default 30 days).
- Rediscover: favorites not requested anywhere in 30 days, previously requested songs first.
- Artist mixes: for each of the listener's top three artists over 90 days, their favorites by
  that artist alternated with what the server plays most by them (anonymous, visible plays,
  early skips excluded).

**Extension point.** `buildYourMix` accepts ranked `recommendations` and reserves up to a fifth
of the mix for them. Smart autoplay's related-track engine can supply them; until then the
list is empty and the mix is built from requests and favorites alone.

## Consequences

- No schema change, migration or retention rule; rolling back removes the feature cleanly.
- A playlist can change between viewing and pressing Play if the listener's stats changed in
  between. Playing resolves the list fresh inside the mutation lane, like `/top play`, and the
  artist mix is addressed by artist name rather than rank.
- Weekly seeds are deterministic, so the same listener sees the same mix on every device.
