# ADR-0015: Songs are recordings, and audio sources sit underneath them

- Status: Proposed
- Date: 2026-10-28

## Context

Every list the bot and portal keep stores a **track reference**: one upload's URL, title, artist
and duration (`trackReference` in `src/utils/library.js`). Search results, the queue, favorites,
mixes and history all hold one. A reference is both what a listener sees and the only way to
play it, which causes two problems:

- **One upload failing breaks the song.** When YouTube refuses an upload, as it refused every
  client for one song on 2026-10-28 (PR #118), the listing has nothing else to play. YouTube is
  hardening against third-party clients, so this will keep happening one video at a time.
- **One song can be listed more than once.** A Topic upload and an "(Official Audio)" upload of
  the same recording are different references, so search, favorites and mixes can hold both.

ADR-0006's song key (`artist|title`) groups uploads only for counting plays, and on purpose it
merges remasters and edits. It doesn't decide what plays.

The owner's rule: a listing is one specific recording. Where its audio comes from doesn't
matter, but it must always be that recording, and the same recording must never be listed twice
because it was found through different sources. A remaster or a radio edit is a different
recording.

## Decision

**A song is one recording.** Its ID comes from the recording's ISRC (International Standard
Recording Code) when one is known: `isrc:USUM71703861`. Without an ISRC, the song is its one
source: `youtube:<videoId>`, `soundcloud:<id>`. Every list is deduplicated and played by song,
so two uploads with the same ISRC are one listing everywhere.

**Metadata comes from the catalog, not the upload.** When an ISRC is found, the song's title,
artist, album, length and artwork come from that catalog entry (Spotify through LavaSrc today).
Changing the audio source never changes what a listener sees.

**Finding the ISRC.** Spotify results carry it. For a YouTube or SoundCloud result, the bot looks
up the catalog by artist and title once. It accepts a match only under the length and title
rules of `sameRecording` (`src/playback-recovery.js`): length within 3 seconds or 2%, and the
same normalized title and artist, so "Song (Live)" or "Song (Remix)" never matches "Song". No
match means no ISRC, and the song stays its single source.

**Each song has verified sources.** A song with an ISRC keeps a short list of sources, each with
how it was verified and when it last played or failed. A source is accepted only if:

- an ISRC search (`ytsearch:"<ISRC>"`, as LavaSrc already mirrors) found it and its length
  passes those rules, or
- it is a YouTube Music Topic upload whose title and artist match and whose length passes
  those rules, or
- it carries the ISRC itself (a catalog source, or later a file in the owner's library).

Music videos and other uploads are never alternates: their intros and edits make them different
audio.

**Playback picks a verified source.** It tries the song's sources in order: last success first,
then Topic uploads, then the rest. It skips a source that failed in the last 6 hours. If none
plays, the song fails with the explanation from PR #118. It never falls back to an unverified
lookalike: a song that doesn't play beats a wrong song playing.

**Listings stay self-sufficient.** List entries keep today's track reference, unchanged. The
store maps each reference's URL to its song, so `library.json` keeps its format: older images
reject a reference with extra fields (`validReference` in `src/utils/library.js`), and rollback
must keep working. Losing the song store degrades playback to today's behavior (each entry plays
its own reference) instead of losing favorites, the same isolation ADR-0006 gives stats.

**A sibling SQLite store.** Songs and their sources live in
`VYBERTRON_DATA_DIR/songs.sqlite`, opened with `node:sqlite` like ADR-0006 and ADR-0009, so it
fails, migrates, prunes and rolls back on its own. It holds metadata, source IDs and the
URL-to-song map only, never audio. A song unused for 365 days is pruned; a list entry that
still refers to it is resolved again on its next play.

**Migration.** Existing favorites, mixes and history are resolved to songs in the background,
through the same ISRC lookup, rate-limited. Where two entries in one list resolve to the same
song, the later duplicate is removed and the earliest position and date are kept, so the list
holds one entry per song. No song is lost from any list.

**Rollout, in order:** (1) the store, identity and ISRC lookup, recording song IDs without
changing any list; (2) lists and search deduplicate by song ID, with the migration; (3) playback
chooses among verified sources. Each is its own PR and can be stopped after.

## Consequences

- One recording, one listing, for every song the catalog knows. Songs it doesn't know (indie
  uploads, some live sets) keep one source and can still be listed twice if two uploads exist.
  Merging those without an ISRC would risk joining different recordings, and the owner's rule
  puts that first.
- The ISRC lookup depends on Spotify through LavaSrc and its `sp_dc` cookie. If Spotify is
  unavailable, new songs get no ISRC until a later lookup succeeds, and play from their single
  source as today.
- Search does more work: each new YouTube result costs one catalog lookup, cached in the store
  after the first.
- ADR-0006's song key is unchanged and still counts plays. Stats keep grouping remasters and
  edits that listings now keep apart.
- New sources (the owner's library through the Subsonic API, SoundCloud) become more sources
  under a song, not new listings.
- Rolling back to an image without the store ignores `songs.sqlite` and plays each entry's
  reference as today. Duplicates the migration removed stay removed.
