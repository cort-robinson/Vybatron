# ADR-0006: Play statistics store and same-song identity

- Status: Accepted; presence is read for room autoplay since [ADR-0012](0012-room-taste-autoplay.md)
- Date: 2026-10-08

## Context

Server favorites ("On repeat", "Forgotten gems") and personal stats need months of per-play
facts: who requested a song, where it played, and whether it was skipped. The music library
(`library.json`) is a single JSON document capped at 5 MiB and rewritten atomically on every
change. Its history keeps 100 entries for 30 days and records no requester or outcome. Adding
months of plays to it would make every favorite or mix save rewrite megabytes and would push it
past its cap.

The same recording also reaches the queue under many names: a YouTube Music "Artist - Topic"
upload, an official video, a lyric video, an "(Official Audio)" upload, a remaster, or a title
with a feat. credit. Counting those separately would split a song's popularity across uploads.

## Decision

**A separate SQLite store.** Play statistics live in `VYBERTRON_DATA_DIR/stats.sqlite`, opened
with Node's built-in `node:sqlite` (unflagged from Node 22.13; the pinned image runs 22.23). No
native dependency is added, so the alpine image needs no build toolchain. `engines` moves to
`>=22.13.0`.

- Schema versioning uses `PRAGMA user_version` and an ordered migration list, each applied in
  one transaction. A newer version or a failed `quick_check` is never modified.
- Durability: WAL with `synchronous = FULL`. Writes are queued and committed in one
  transaction per short batch (250 ms), so a track start never waits for a disk sync.
  Shutdown flushes, checkpoints the WAL and closes, leaving one file.
- Bounded growth: 365-day retention, 10,000 plays per server, 50,000 plays in total, and a
  16 MiB file guard that sheds the oldest plays. Release snapshots copy the whole data volume
  under a 64 MiB cap, so the store stays well inside it. Pruning runs at open and hourly.
- Isolation: stats are optional. A failed open (corrupt file, newer schema, full disk) disables
  the store, logs `stats_unavailable` without raw error text, and leaves the file in place for
  an operator. Every write path catches its own failure, so playback, the library and startup
  never depend on it. Reads report "unavailable" (portal 503 `stats_unavailable`).
- Backfill: on first open, existing `guild.history` entries are imported once as plays with an
  unknown requester and no outcome.

**What a play records.** Server, song key, voice channel, start time, the requester's user ID
(the human who queued it; picks queued as the bot user, such as radio or autoplay, are
`autoplay`), played milliseconds, completion (natural end or at least 90%) and early skip (moved
on before 30 seconds or 40%). Stops, disconnects and source failures are never early skips;
failures under 30 seconds are discarded. Recovery replays continue the same play. Listeners
merely present in voice are never stored (ADR-0012 reads presence to choose room autoplay seeds). "Clear my request stats" replaces the user's
ID with an anonymous `cleared` marker everywhere, so server totals survive without the person.

**Same-song identity.** `src/utils/song-identity.js` derives `artist|title` from catalog metadata
alone. It folds case, accents and apostrophes; reads "Artist - Title" from non-topic uploads;
drops bracketed or trailing upload descriptors (official/lyric/audio video, HD, remastered,
radio edit), feat. credits and `| channel` suffixes; strips "- Topic"/VEVO channel suffixes; and
keys on the first credited artist. Live, remix, acoustic, cover, sped-up and similar versions stay
distinct. When nothing remains, the key falls back to the catalog ID. Each song keeps its most
playable reference: topic uploads, then official audio, then other uploads, then Spotify mirrors.
The module is pure so autoplay dedupe can reuse it.

**Scoring.** On repeat ranks the last 90 days with a 14-day half-life. The first play per
requester counts fully and repeats count a quarter; unattended and backfilled plays count half;
each early skip subtracts half a play. Forgotten gems are songs scoring at least 2 from plays 60
to 120 days ago with no play since. Both lists, and personal top tracks and artists, include only
plays in voice channels the viewer can currently see.

## Consequences

- `library.json` and its invariants are unchanged; stats can be deleted without losing favorites.
- Node prints one `ExperimentalWarning` for `node:sqlite` at startup. It is expected.
- The identity rule is heuristic. Reversed "Title - Artist" uploads from unrelated channels and
  different songs that share an artist and title can still split or merge.
- Rolling back to a release without stats leaves `stats.sqlite` unused; portal rollback
  quarantines it with other candidate-only files.
