# ADR-0009: Listening state store beside the music library

- Status: Accepted
- Date: 2026-10-17

## Context

`library.json` holds two kinds of data with very different write rates. Favorites, mixes and
server settings change when a person edits them. Server history (every track start), actor
activity (every queue or settings edit) and session checkpoints (every queue change and every
15 seconds while a player exists) change constantly. Every one of those writes goes through
`updateDocument`, which clones, validates, serializes, fsyncs and renames the whole document,
up to 5 MiB, so the cost of a track start grows with the size of everyone's favorites.

Play statistics already live in SQLite (ADR-0006). Older bot images only know `library.json`
version 2, and they reject a document whose guilds lack `history` and `activity` arrays.

## Decision

**A sibling SQLite store for listening state.** Server history, actor activity and session
checkpoints live in `VYBERTRON_DATA_DIR/listening-state.sqlite`, opened with `node:sqlite`.
Favorites, mixes and settings stay in `library.json`. `MusicLibrary` remains the only interface:
`readGuild` returns the same shape, and every write still runs in its one transaction queue, so
callers and write ordering are unchanged. Writes that touch only listening state skip the JSON
document entirely.

It is a separate file, not more tables in `stats.sqlite`, so the stores fail, migrate, prune
and roll back independently, and deleting stats never touches history or a saved session.

- **Behavior is unchanged.** History keeps 100 items for 30 days per server with the voice
  channel used for visibility; activity keeps 200 items for 24 hours; a checkpoint restores
  within 72 hours. Reads apply the same windows and limits, so pruning only reclaims space.
- **Durability.** WAL with `synchronous = NORMAL`: a commit survives a process crash; an
  operating-system crash or power loss can drop the last few seconds of history or the latest
  checkpoint, never favorites (still fsynced JSON) and never a corrupt file. `node:sqlite` is
  synchronous, so this keeps fsync off the event loop on every track start. Shutdown
  checkpoints and truncates the WAL, leaving one self-contained file for snapshots.
- **Size.** Listening state still counts against the 5 MiB `library.json` cap, exactly as when
  it lived inside the document: a write that would make the mirror (below) overflow it is
  rejected with "Music library is full", so the mirror always fits. If adopting an older
  image's mirror would overflow it, the oldest history and activity are shed until it fits, and
  servers beyond the 1,000-server limit lose the listening state of the least recently active
  ones that have no settings or mixes. A document write that only the stale frozen mirror would
  overflow refreshes the mirror instead of failing. That bounds the store's
  content to about 5 MiB; an 8 MiB guard (oldest history and activity first, then checkpoints)
  is a backstop, and shutdown prunes and vacuums before the snapshot. The pre-deploy snapshot
  copies the whole volume under 64 MiB: library ≤ 5 MiB, its one-time backups (v1 and this
  migration) ≤ 10 MiB, stats ≤ 16 MiB (plus a ≤ 4 MiB WAL only while running) and listening
  state ≤ 8 MiB stay below 45 MiB.
- **Failure isolation.** Listening state is optional, like stats, because losing it must never
  stop music. Any failure while opening, backing up or adopting (corrupt file, newer schema, full
  disk) leaves the file untouched for an operator, logs `listening_state_unavailable`, and runs
  from memory seeded from `library.json`; the migration is retried on the next start; that memory is written back to `library.json` hourly and at shutdown. A failed
  write rejects only that write, which callers already log and drop, as before. Favorites,
  mixes and settings keep their stricter rule: a damaged `library.json` still fails startup.
  Repair: stop the bot and move the file aside; the next start rebuilds it from `library.json`.

**Migration and rollback.** `library.json` keeps its version 2 shape, including each guild's
`history`, `activity` and `session`, so any older image can still open it. Those fields become a
**mirror**: frozen during normal running and rewritten from the store at graceful shutdown (and
hourly when the store is in memory). For each guild the store records a digest of the mirror it
last read or wrote.

- On every start, a guild whose mirror no longer matches its digest was written by someone
  else, an older image after a rollback or the first start of this release. Its history and
  activity are merged by ID and its checkpoint, including an absent one, replaces the stored
  checkpoint. Matching guilds are left alone, so restarts import nothing and repeats are
  idempotent.
- Before the first import the exact `library.json` bytes are written, synced and then renamed
  to `library.json.pre-listening-state.bak`, so only a complete backup counts and it is never
  overwritten. The migration itself never rewrites `library.json`.
- Deploy stops the bot gracefully before its snapshot, so the mirror is current when an older
  image starts after a rollback: it sees the latest history and can restore the session. An
  automatic portal rollback restores the pre-release volume and quarantines
  `listening-state.sqlite` as a candidate-only file; the next release imports again.

## Considered options

- *Cheaper JSON writes* (debounce, split per guild): still rewrites a whole document per track
  start, and debouncing loses the crash safety the checkpoint exists for.
- *Tables in `stats.sqlite`*: shares the 16 MiB budget and its failure mode with optional stats.
- *Strip the fields from `library.json`*: older images refuse to start after a rollback.
- *Dual-write both stores on every change*: keeps the cost this change removes.

## Consequences

- After a crash (no graceful shutdown) followed by a rollback, the older image sees the mirror
  from the previous shutdown. The newer data stays in `listening-state.sqlite` and returns on
  roll-forward.
- A mirror that cannot be written (disk error) is logged. The store keeps the data, the next
  start adopts nothing stale, and an older image after a rollback would see the previous mirror.
- An `updateGuild` that changes both settings or mixes and listening state commits the document
  first, then the store; a failure between them leaves the document change applied.
