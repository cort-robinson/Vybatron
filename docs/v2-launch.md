# Vybertron v2 launch evidence

## Release candidate

This release prioritizes real audio recovery, then personal and shared music
libraries, fair listening, discovery, and a clear desktop/mobile Discord player.
The implementation contract is [SPEC.md](../SPEC.md); operator instructions and
rollback are in [ops/README.md](../ops/README.md).

**Bot Testing acceptance passes. Vybertron v2 is ready for wider rollout.**
The current image is running in the selected test server; global command
registration and promotion to `main` are separate rollout steps.

## Verified source stack on 2026-10-04

- Lavalink 4.2.2 with pinned client 2.10.3 and current Discord DAVE support.
- Production's YouTube snapshot `2be8e542d3f6f178e048dca565892684c2e40177`
  matches the published jar's SHA-256:
  `b062effdda6abeaa46913dfd1b5d5600120b65f239ce88f30948c7213a3ca1c0`.
- Two installed-source canaries fully decoded through FINISHED: 18.947 seconds
  with 946 Opus frames and 217.385 seconds with 10,866 frames.
- Live YouTube/YTMusic, SoundCloud, and Bandcamp catalog lookups passed.
- Native Spotify lookup failed in the deployed source. The public embed fallback
  matched Mr. Brightside and all 14 displayed Hot Fuss album tracks to real fresh
  YouTube recordings, preserving listed order.
- Two matched Spotify recordings fully decoded through FINISHED: Mr. Brightside
  with 11,147 Opus frames and Jenny Was A Friend Of Mine with 12,243 frames.
- These probes saved no audio and did not join Discord voice. They establish
  source decoding separately from final audible delivery.

## Automated release gates

- Node tests: command guards, library persistence, native SDK recovery,
  voice ordering, resumed/missing remote tracks, progress watchdog, Stop races,
  filters, player/controller state, radio, majority voting, and Spotify matching.
- Python tests: bounded repair/update decisions, probe schemas, interrupted
  journals, exact-commit release, idle rechecks, and rollback.
- Dependency audit: no reported production vulnerabilities.
- Container: digest-pinned runtime, non-root data persistence on read-only root,
  startup/readiness, and bounded resource/log settings.
- Linux WARP supervisor: two daemon deaths recover without replacing its network
  namespace; actual entrypoint failure propagates to Docker.
- Compose validation, complete 25-command registration, and exact release image.

Clean-install verification on 2026-10-04: **322 Node tests** and **44 Python
tests** pass, with no skipped tests; production dependency audit reports zero
vulnerabilities. The exact release container also passes all 322 Node tests on
Linux. Separate fresh containers verify that the non-root runtime can write and
reopen its persistent library with a read-only root filesystem. CI passes for
the candidate revision below.

## Running candidate

- Source revision: `4cb73957c906fd8f4954385132538a66488d07cf`.
- Image: `sha256:8c715847c8fda33b6a042ef56bc2f92070da2b91e01d2af4593d51634bb36d92`.
- The VPS confirms this image and revision, user `node`, a read-only root,
  persistent `/app/data`, a 256 MiB memory limit, and healthy Discord/audio
  readiness. Only the bot was replaced; the verified audio images and plugin
  were retained. The full Compose resource limits are validated separately.
- All 25 commands are registered in **Bot Testing** only. The release has not
  been merged to `main` or registered globally; those are wider rollout steps.
- Forced control-socket disconnects on the initial candidate recovered while
  idle and playing in 10.867 and 11.067 seconds respectively. The playing check
  retained the same session, recording, voice connection, advancing position,
  and filters. A separate paused two-song check preserved its queue, pause,
  position, and filters across control reconnection.
- The current candidate's paused control reconnect passes in 10.845 seconds,
  retaining the same process, Lavalink session, recording, voice connection,
  pause, reported position, and filters. This check held one paused track;
  the earlier two-song check and native regressions cover the upcoming queue.
- The prior bot image and Bot Testing command catalog are retained in private
  rollback state on the VPS. No credentials are recorded in this evidence.

This evidence records the running code candidate. Subsequent documentation
commits do not change that image's source identity. Bot Testing acceptance and
wider rollout are recorded separately.

## Saved-position defect found during live acceptance

The first candidate restored its two-song checkpoint, but the owner saw
"Queue Finished" when resuming. Lavalink re-encodes a live AudioTrack for events,
including its current position. Comparing that changing encoding to the catalog
encoding rejected genuine start, end, and failure events after a nonzero restore
or seek. The initial native fixtures incorrectly echoed a static encoding.

The patched candidate trusts the current unique playback-attempt token. Missing,
older, and already-ended tokens remain rejected. Recovery also captures a valid
failure-event position before retrying, because a missing-track update can reset
the reported player position to zero. Six new native regressions model real
Base64 track encoding, the position trailer, and omitted-field PATCH semantics.
They cover paused restore, resume, natural finish after seek, source failure,
position-zero updates, and stale-token rejection. Revision `2fd7ae4` passed all
304 tests locally and inside its exact Linux image, with passing CI. The current
candidate includes this fix and passes the expanded 322-test suite.

The original two-song checkpoint was preserved at 107,420 ms in General. The patched
candidate restores both songs in order, with the same recording and volume,
paused at that position and connected to the original voice channel. The owner
confirmed that both songs restore paused near 1:47 and Resume plays clear audio.

## Final listening acceptance

Target: **Bot Testing**, **General** voice. The owner confirmed clear playback and
working pause/resume, seek, and Warm filter on Windows desktop and phone. The
patched two-song restore and resumed playback also pass the owner's check.
The automatic end-to-next-song check found another defect on revision `2fd7ae4`.
The second recording received a combined YouTube client failure: HTTP 403,
requires-login, and no supported streams. Recovery incorrectly treated the
login wording as permanent recording unavailability and skipped its exact-source
retry. The same installed plugin/configuration fully decoded the public recording
in a fresh isolated source manager: 217,385 ms, 10,866 frames, FINISHED. That
establishes availability separately from the live manager's cached client state.

The current patch keeps aggregate client failures eligible for bounded exact-recording
recovery. Native regressions reproduce the natural short-to-long handoff and its
mixed failure, with a duplicate old finish event still fenced. Unavailable and
paused timestamps now use reported progress rather than the SDK's elapsed-time
getter. The installed
[YouTube exception format](https://github.com/lavalink-devs/youtube-source/blob/2be8e542d3f6f178e048dca565892684c2e40177/common/src/main/java/dev/lavalink/youtube/AllClientsFailedException.java)
concatenates each client's failure, so one nested login restriction cannot establish
permanent recording unavailability. Direct YouTube requests retain one exact
refresh; retries and repeated failure handling remain bounded.

Native tests also found two cleanup gaps: a failed Discord leave could strand a
dead player, and an empty player could retain stale voice state after Lavalink
lost its session. Teardown now has one deadline, completes local lifecycle cleanup,
and fences each old operation against a replacement player. Idle reconciliation
preserves queued tracks and requires fresh voice on the next explicit play. It
does not automatically join voice. Late old-player cleanup cannot clear the new
session's controller, presence, voice status, or idle deadline.

All 322 tests pass locally and in the exact Linux container; CI also passes the
full Node/Python, audit, container, WARP-supervisor, and Compose gates. The candidate
was replaced while idle under the maintenance lease, with identical writable data
volume and saved-library contents. The owner confirms the patched automatic
short-to-long queue transition starts the second song and plays clear audio.
The live REST trace also shows the second recording starting at position zero
after the short clip finishes, with no stop/skip request between recordings.

The following checklist also supports future release and feature-tour testing;
automated feature coverage does not imply that every item was manually toured.

1. Use `/play` with a fresh autocomplete result and a direct YouTube link; listen
   for normal start, sustained audio, and a clean track ending/queue transition.
2. Play a public Spotify track or album. Check full songs, the matched-count
   notice, and queue behavior; previews must never enter the player.
3. Try Pause/Resume, Seek, Skip, Original/Warm filter, and Stop. Stop must stay
   responsive during an import, disconnect, and permit a fresh `/play`.
4. Favorite a playing track, save/load a small mix, and use History/Replay.
   Private menus should work on both desktop and mobile.
5. Enable radio with humans present, let a short queue end, and confirm one
   related track follows. Disable radio before finishing the test.
6. During the controlled listening session, interrupt only the
   candidate's Lavalink control socket and confirm recovery at the last reported
   position with the upcoming queue intact. Terminal failure must show Audio
   Unavailable and leave Skip/Stop usable.
7. Rebuild/restart the candidate gracefully, confirm saved libraries survive,
   and explicitly `/session resume` in the original voice channel. A paused
   checkpoint must restore paused. Stop must discard that checkpoint.

Human feedback records audible results; connection flags or Opus counts alone
do not satisfy this listening gate. Keep the previous release image and private
rollback state through the wider rollout.
