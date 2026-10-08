# ADR-0008: Smart autoplay from YouTube mixes

- Status: Accepted
- Date: 2026-10-08
- Supersedes: the "No autoplay" clause of [ADR-0004](0004-sources-and-playback-behavior.md)

## Context

Friends want the room to keep going when the queue runs out, the way YouTube Music's
"up next" does. The opt-in artist radio searched `ytmsearch:"<artist> music"`, stayed
on one artist, and picked randomly, so it drifted nowhere and repeated itself.

The youtube-source plugin already loads playlist IDs (`allowDirectPlaylistIds: true`).
A YouTube mix, `watch?v=<id>&list=RD<id>`, returns about 25 related tracks with the seed
first: the same related-music signal YouTube uses. On 2026-10-08 a local Lavalink 4.2.2
with the pinned plugin and yt-cipher loaded 25-track mixes for three seeds and decoded
real audio (250 non-zero PCM frames each) from three mix entries with the repository's
`ops/PlaybackProbe.java`. A malformed mix returns `loadType: error`.

## Decision

- **Recommendations:** load the mix of a recently played seed. Seeds rotate across the
  last four plays (current first), so the station drifts with the room. A song or link
  chosen with "Start radio" leads the first picks. A non-YouTube seed is resolved with
  a YouTube Music search first. If the mix fails or has nothing fresh, the original
  same-artist search is the fallback.
- **Filters:** skip the seed, streams, tracks under 30 seconds or over 15 minutes,
  anything played in the server in the last 24 hours (library history), anything in
  this session (current, queue, previous, suggestions), and session exclusions. Light
  near-duplicate keys (normalized artist + title, minus "Official Video"/"Lyrics"/"Topic"
  noise, plus "Artist - Title" uploads) and the ADR-0006 song key catch other uploads
  of the same recording.
- **Human queue first:** picks wait in an in-memory buffer of at most three
  suggestions, never in `player.queue`. One pick enters the queue only when the human
  queue is empty (the SDK's empty-queue hook, or a skip with nothing queued), so
  anything a person adds always plays first. Suggestions are prepared only when two or
  fewer human songs remain.
- **Requester:** every autoplay pick, including a suggestion a listener promotes into
  the queue, is queued with `requester: client.user`. The play-statistics store uses this
  to separate autoplay plays from songs people chose. A promoted pick plays in queue
  order and stays eligible for "less like this".
- **Less like this:** skipping an autoplay pick, or a thumbs-down, excludes that song for
  the session, retires it as a seed, adds a strike to the seed that produced it, and
  drops prepared picks from that seed. Seeds with strikes sort last; two strikes retire
  a seed. This is per-session memory only.
- **Setting:** a server `autoplay` setting is `off`, `on`, or `listening` (only while a
  human in voice is not deafened). Version-2 libraries without the field read as `off`,
  so existing servers keep their behavior. `/radio on [track]` and `/radio off` override
  it for the current session.
- **Bounds:** single flight per session, one maintenance lease per lookup, 8-second
  lookup timeouts, at most two seeds plus one fallback search per pick, and a 30-minute
  cache of at most eight mixes. Three consecutive empty lookups pause autoplay for the
  session; `/radio on` or a new setting re-arms it. No timer retries.

## Consequences

- Autoplay depends on YouTube playlist loading. When that breaks upstream, the artist
  search keeps working, with lower quality.
- Suggestion state is in memory and ends with the player. It is not checkpointed, and
  "less like this" does not persist across sessions or restarts.
- The portal snapshot gains `session.suggestions`, `session.autoplay`, a session-only
  `Track.suggested`, and `settings.autoplay` (see `docs/portal-contract.md`).
- The 5-minute idle and empty-voice disconnects (ADR-0004) still apply. Autoplay never
  inserts into an empty room, so it cannot hold a session open on its own.
