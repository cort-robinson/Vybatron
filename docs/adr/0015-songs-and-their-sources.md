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
matter, but it must always be that recording, and the same recording must not be listed twice
because it was found through different sources. A live version, an edit or a re-recording is a
different recording.

Metadata can't prove that two uploads are one recording. Title, artist and length match across
remasters, clean versions and re-recordings. An ISRC isn't unique either: a remaster may keep its
original ISRC, and one recording can carry several. Searching YouTube for an ISRC finds uploads
that don't carry it. And LavaSrc's Spotify playback (4.8.3, `DefaultMirroringAudioTrackResolver`)
plays the first result of its providers, the last of which is a plain title search, unchecked.

The audio itself is better evidence. The bot already decodes each song into a 16-band energy map
at 30 frames a second for the visualizers (ADR-0013). Two uploads of one recording have the same
energy over time; a live version, an edit or a re-recording doesn't. A remaster that differs only
in mastering usually looks the same. The owner accepted that a remaster with no other evidence
to tell it apart may share its original's listing, rather than allow duplicates.

## Decision

**A song has an internal ID.** `song:<random>`, assigned once and never derived from metadata.
An ISRC, a Spotify track ID and a song key are facts about a song, not its identity.

**Two sources are one song only when their audio matches.** A source is an upload or file:
`youtube:<videoId>`, `soundcloud:<id>`, later a file in the owner's library. Two sources are
merged only when all of these hold:

- Their lengths are within 3 seconds or 2% of the shorter, whichever is smaller.
- Their normalized title and artist are equal, or both are linked to the same catalog entry.
  Normalization is the one `src/playback-recovery.js` uses (NFKC, lower case, " - Topic"
  removed, everything but letters and digits folded to spaces), so "Song (Live)" and "Song" never
  match.
- Their **fingerprints** match: each energy map is reduced to 16 bands at 2 frames a second
  (under 4 KB for a long song), aligned within 2 seconds to allow for leading silence, and
  correlated above a threshold. PR 3 sets the threshold from known pairs (a Topic upload and its
  official audio; studio and live; an album version and its edit; an original and a
  re-recording) and records it here before this ADR is accepted.

Nothing weaker merges songs. A metadata match makes a source a candidate, never a member.

**Catalog data is for display, never for playback.** A song may be linked to a catalog entry
(Spotify through LavaSrc today) when its first source passes the length, title and artist checks
against it. The link supplies the title, artist, album and artwork shown, so changing the audio
source never changes what a listener sees. Songs never play through LavaSrc's mirror resolution.
A Spotify result is played by resolving candidate uploads; the first one that passes the length,
title and artist checks becomes the song's first source, as Spotify mirroring does today.

**Each song keeps a fingerprint and verified sources.** The first time a song plays, in Discord
or on a device, the bot fetches its source's Ogg audio from the plugin in the audio cache's
background slot (a device play reuses the download it already has) and stores the song's
fingerprint. Discord playback itself never goes through the plugin. In the background, rate-limited
and only in the audio cache's background download slot, it looks for alternates: an ISRC search,
a YouTube Music search for the title and artist, and Topic uploads. Candidates that pass the
length and title checks are downloaded, measured and compared. Those that match become verified
sources. A song whose only source fails before it was ever fingerprinted has no alternates and
fails with the explanation from PR #118.

**Playback uses only verified sources.** It tries the song's sources in order: last success
first, then Topic uploads, then the rest. It skips a source that failed in the last 6 hours. It
never plays an unverified lookalike.

**Merges are transactional.** When two songs turn out to be one recording, the older ID survives.
The other becomes an alias, and its sources and URL mappings move over in one transaction.
Lookups that fail for a temporary reason (Spotify or Lavalink unavailable, busy) are retried after
1, 6 and 24 hours, then daily for a week, then only when the song plays again.

**Lists deduplicate by song.** Search results are grouped by the songs their sources are already
mapped to. A new upload shows as itself until it has been fingerprinted, so a duplicate can
appear briefly in search. In favorites and mixes, entries that resolve to the same song after a
merge are reduced to one: the earliest position and date are kept, and the later entry is
removed in a background pass. History and the queue are records of plays and requests, so they
are never rewritten. Server history shows each occurrence, as now, filtered by channel
visibility first.

**`library.json` keeps its format.** List entries keep today's track reference, unchanged. The
store maps each reference's URL to its song, so older images, which reject a reference with
extra fields (`validReference` in `src/utils/library.js`), still read the document, and rollback
works. Losing the store degrades playback to today's behavior: each entry plays its own
reference.

**A sibling SQLite store.** Songs, aliases, sources, fingerprints and the URL map live in
`VYBERTRON_DATA_DIR/songs.sqlite`, opened with `node:sqlite` like ADR-0006 and ADR-0009, so it
fails, migrates, prunes and rolls back on its own. It holds no audio. Its budget is 50,000 songs,
8 sources per song and a 32 MiB file guard that sheds songs unused for longest. A song unused for
365 days is pruned; a list entry that still refers to it is resolved again on its next play.
`ops/backup.py` backs it up and restores it with the other databases (an `ops/` change, held for
approval), and the release snapshot's 64 MiB cap is checked with it included.

**Rollout, in order, each its own PR and safe to stop after:**

1. The store, song IDs, catalog links and fingerprints, recorded without changing any list or
   playback. Backup integration.
2. Alternate discovery, verification and the threshold calibration, still without changing
   playback.
3. Playback choosing among verified sources.
4. Search grouping and favorites and mixes deduplicated by song.

## Consequences

- A listing plays its recording or fails with an explanation; it never plays a different
  performance, edit or re-recording.
- A remaster that sounds the same as its original, with no other evidence to separate them, may
  share one listing. The owner accepted this.
- Duplicates go away once their uploads have been fingerprinted, not at once: a new upload can
  show beside its song in search until then.
- A song needs one successful play before it gains alternates. A song that never played can't be
  rescued when its only upload fails.
- Every alternate costs a background download and about 1.4 s of worker CPU to measure (ADR-0013).
  Discovery runs only in the background slot, so it never delays a listener's song.
- Fingerprints come only from the plugin's Ogg Opus. Songs reached only through the YouTube
  plugin's mp4/webm fallbacks, or sources the bot can't decode, can't be verified and stay single
  sources.
- ADR-0006's song key is unchanged and still counts plays.
- New sources (the owner's library through the Subsonic API, SoundCloud) become more sources
  under a song, once verified, not new listings.
- Rolling back to an image without the store ignores `songs.sqlite` and plays each entry's
  reference as today. Duplicates already removed from favorites and mixes stay removed.
