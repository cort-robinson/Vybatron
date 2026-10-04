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
vulnerabilities. The exact release container also passes all298 Node tests on
Linux. Separate fresh containers verify that the non-root runtime can write and
reopen its persistent library with a read-only root filesystem. CI passes for
the candidate revision below.

## Running candidate

- Source revision: `3ac0de1c75dcca2e784d8d1bacd5377ed7207a74`.
- Image: `sha256:2e8fd71f549b8362d6255431ef4d7a00c1919bd9befbbc311dd381894a00459f`.
- The VPS confirms this image and revision, user `node`, a read-only root,
  persistent `/app/data`, a256 MiB memory limit, and healthy Discord/audio
  readiness. Only the bot was replaced; the verified audio images and plugin
  were retained. The full Compose resource limits are validated separately.
- All25 commands are registered in **Bot Testing** only. Global registration
  and merging the release are pending listening acceptance.
- A forced idle Lavalink control-socket disconnect recovered in10.867seconds
  with the same bot process and healthy readiness. This establishes control
  reconnection; audible continuity and queued-track preservation are checked
  separately during the listening gate.
- The prior bot image and Bot Testing command catalog are retained in private
  rollback state on the VPS. No credentials are recorded in this evidence.

This evidence records the running code candidate. Subsequent documentation
commits do not change that image's source identity. Do not label the candidate
fully launched until the listening gate below is complete.

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
