# Vybertron v2 launch evidence

## Release candidate

This release prioritizes real audio recovery, then personal and shared music
libraries, fair listening, discovery, and a clear desktop/mobile Discord player.
The implementation contract is [SPEC.md](../SPEC.md); operator instructions and
rollback are in [ops/README.md](../ops/README.md).

## Verified source stack on 2026-10-04

- Lavalink4.2.2 with pinned client2.10.3 and current Discord DAVE support.
- Production's YouTube snapshot2be8e542d3f6f178e048dca565892684c2e40177
  matches the published jar's SHA-256:
  `b062effdda6abeaa46913dfd1b5d5600120b65f239ce88f30948c7213a3ca1c0`.
- Two installed-source canaries fully decoded through FINISHED:18.947seconds
  with946 Opus frames and217.385seconds with10866 frames.
- Live YouTube/YTMusic, SoundCloud, and Bandcamp catalog lookups passed.
- Native Spotify lookup failed in the deployed source. The public embed fallback
  matched Mr. Brightside and all14 displayed Hot Fuss album tracks to real fresh
  YouTube recordings, preserving listed order.
- Two matched Spotify recordings fully decoded through FINISHED: Mr. Brightside
  with11147 Opus frames and Jenny Was A Friend Of Mine with12243 frames.
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
- Compose validation, complete25-command registration, and exact release image.

Clean-install verification on2026-10-04: **298 Node tests** and **44 Python
tests** pass, with no skipped tests; production dependency audit reports zero
vulnerabilities. Candidate container identity and deployment checks are recorded
when packaging finishes. Do not label a candidate fully launched until the
listening gate below is complete.

## Final listening acceptance

Target: **Bot Testing**, **General** voice. The owner will check audio on the
Windows desktop and phone. This gate is currently pending.

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
rollback state until acceptance succeeds.
