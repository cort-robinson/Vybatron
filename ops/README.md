# Automatic recovery on the VPS

The systemd timer checks the running stack about five minutes after each completed
run. It checks WARP health and shared network namespaces, Discord/Lavalink
connectivity, YouTube search, and five seconds of decoded audio from each of two
known videos. It never joins a Discord voice channel or saves audio.
The samples include a broadly available short video and a full music track;
explicit regional/private-video restrictions do not trigger plugin updates.

Persistent infrastructure failures allow at most two service recovery attempts in
six hours, at least thirty minutes apart. A missing WARP daemon already has a
five-second supervisor; an unhealthy WARP connection can also be repaired without
replacing its shared network namespace. Intentionally stopped containers stay
stopped. Known active players prevent service restarts. Audio source failures do
not trigger blind restarts.

The yt-cipher image has no shell for a Docker healthcheck, so the monitor checks
it over the shared namespace from the bot container. An unresponsive cipher is
restarted alone (keeping WARP's namespace) under the same idle and attempt limits.
A failed canary probe is retried once within the run. When one canary fails while
the other plays, the alert waits for three consecutive degraded runs (about fifteen
minutes); other failures still alert after two. Non-healthy run lines in the
journal include `failed_canaries` (track index, category, ending) so recurring
flaps can be traced to a specific test video.

Paused and queued tracks also prevent recovery, even when the audio server cannot
report a player count. Infrastructure repair must pass the bot's idle check and
maintenance gate. An interrupted deployment blocks automatic recovery until its
deployment journal is resolved.

The bot also exposes recent real YouTube playback failures on its loopback-only
`/playback` endpoint. Only ten public video IDs and event timestamps are retained,
for fifteen minutes; server-reported playback progress clears a recovered video.
The monitor tests the actual failed video. If a fresh player succeeds while the
live service failed, it can restart the idle audio service under the same
cooldown and attempt limits. Each event is handled once. Failures reproduced by
the probe follow the source-update policy instead. This detects stale live-source
state that fixed, fresh-process canaries alone cannot detect. Failed final tracks
show Playback Unavailable rather than Queue Finished.

With `auto_update` enabled, official youtube-source releases and main commits are
checked every six hours and after repeated playback failures. A candidate must
be at least as recent as the current upstream commit, have a published Maven jar,
and play **two complete tracks through Discord's Opus encoder** in a separate
container using the deployed Lavalink libraries, client settings, and WARP route.
The container receives only the YouTube credentials it needs, never the bot token.
It has a memory/CPU limit, a time limit, and is removed even after a timeout.

Installation waits for no playing/paused/current/queued track and no in-flight
`/play` or `/playnext`. A short maintenance gate prevents new requests from racing
installation. The bot reconnects automatically after Lavalink restarts. The
loaded version, exact tested jar hash, search, bot connection, and two complete
tracks are checked again afterward. A failed update restores the previous
configuration; a durable journal also handles interruption. Rollback requires an
idle player and allows at most two attempts before requesting attention. Updates
are limited to two per day; failed candidates wait at least an hour before retry.

Alerts go to the configured Discord channel: one startup message, persistent
outages, recovery, installations, and rollbacks. Successful routine checks stay
quiet. Failed alert delivery remains in a private outbox for retry. A total VPS
or Discord outage cannot deliver an alert until connectivity returns. External
YouTube changes without a working upstream fix and expired OAuth credentials can
still require manual intervention. Canary checks do not prove Discord voice
delivery or playback of every possible track.

The outbox holds at most 32 notices, delivers at most five per run, and stops at
the first failed delivery. Decoder results are schema-checked and retain only
audio counts, completion state, and public error categories.

## Installation

Requires the deployed bot health endpoint, Docker Compose, Python 3, systemd,
and the repo at `/root/Vybertron`. These units run as root because they operate
Docker. No additional Python packages are required. The first probe compiles its
Java helper with a pinned JDK image; subsequent runs reuse the compiled bundle.
The current bundle and two older bundles are retained to bound cache disk use.

Create `/var/lib/vybertron-recovery` with mode `700` and `settings.json` inside it
with mode `600`:

```json
{
  "auto_update": true,
  "discord_guild_id": "YOUR_SERVER_ID",
  "discord_channel_id": "YOUR_TEXT_CHANNEL_ID"
}
```

The bot must have View Channel and Send Messages in that channel. No webhook or
extra token is needed. Guild membership is verified before sending each alert.

```bash
cd /root/Vybertron
python3 ops/recovery.py check
python3 ops/recovery.py run
install -m 644 ops/vybertron-recovery.service ops/vybertron-recovery.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now vybertron-recovery.timer
```

## Host baseline

The VPS has 2 GiB of RAM, so the Compose memory ceilings are what keep one service
from exhausting the host (an uncapped yt-cipher grew to ~600 MiB and triggered a
global OOM on 2026-10-14). SSH is key-only (`/etc/ssh/sshd_config.d/00-hardening.conf`)
with fail2ban's `sshd` jail; ModemManager, udisks2, fwupd and multipathd are
masked. Reapply these when replacing the VPS.

## Operations

```bash
python3 /root/Vybertron/ops/recovery.py status
journalctl -u vybertron-recovery.service --since today
systemctl list-timers vybertron-recovery.timer

# Pause future checks/recovery. An already-running transaction still finishes.
touch /var/lib/vybertron-recovery/paused
# Resume.
rm /var/lib/vybertron-recovery/paused
```

`check` performs checks and records observations without recovering, updating,
or delivering alerts. `run` applies the configured recovery policy. Both acquire
`/run/lock/vybertron-maintenance.lock`; deployments hold the same lock. Do not edit
the configuration or operate Compose concurrently without this lock.

Automatic updates intentionally change only the local YouTube dependency pin.
The deployment workflow reapplies a previously tested runtime pin after a git
reset when the repository's pin is unchanged. An explicit new repository pin
takes precedence. Keep the state directory: it contains backups, the pending
transaction, tested override, alert outbox, and rate limits. If rollback exhausts
its attempts, pause the timer, inspect the private backup and current config,
repair playback manually, then resolve the `pending` journal before resuming.

Tests: `python3 -m unittest discover -s tests -p '*_test.py'` and `npm test`.

## Device audio plugin

`lavalink/plugins/vybatron-audio` is a small Lavalink plugin that streams a song's
audio as Ogg Opus at `/vybatron/audio/{videoId}` for portal listeners playing on
their own device. It decodes through the same pipeline as Discord playback, on a
private player that belongs to no session (two exports at a time, 60-minute cap).
The jar is not in Git; build it on the VPS from the compose checkout, offline,
against the running Lavalink's own libraries and the probe's pinned JDK:

```sh
cd /root/Vybertron && lavalink/plugins/build.sh
```

Compose mounts `lavalink/plugins` read-only and Lavalink's entrypoint copies the jar
into its plugins folder at start. Without the jar Lavalink starts exactly as before;
only device audio is unavailable (the bot then tries the YouTube plugin's stream
route). Rebuild after changing the plugin source or the Lavalink image, then
recreate Lavalink under the maintenance lock with an idle bot, as for any audio
release:

```sh
flock -n /run/lock/vybertron-maintenance.lock sh -c '
  docker exec vybertron-bot node -e "fetch(\"http://127.0.0.1:3000/maintenance/begin\",{method:\"POST\"}).then(r=>r.json()).then(s=>process.exit(s.busy||s.inFlight?1:0))" &&
  docker compose up -d --no-deps --no-build --pull never --force-recreate --wait lavalink;
  docker exec vybertron-bot node -e "fetch(\"http://127.0.0.1:3000/maintenance/end\",{method:\"POST\"})"'
```

## V2 runtime and releases

The bot runs on a digest-pinned Node 22 image as the unprivileged `node` user,
with a read-only filesystem, a small temporary filesystem, and rotating logs.
`bot-data:/app/data` persists the library, recoverable listening sessions and
`stats.sqlite` play statistics (bounded to 16 MiB; see ADR-0006). The stats store
uses WAL while running and checkpoints to a single file on graceful shutdown, so
copy the volume with the bot stopped. A damaged or newer `stats.sqlite` disables
stats only (`stats_unavailable` in the log, `stats.available: false` in `/status`);
move it aside while the bot is stopped to start fresh. Playback is unaffected.
Back up that volume before migrating or replacing the VPS. Removing the volume
removes saved data; a normal container rebuild preserves it.

Measured on the existing 2 GiB VPS, the cipher service used about 311 MiB.
Ceilings allow 512 MiB for cipher, 768 MiB for Lavalink including its 512 MiB Java
heap, 384 MiB for WARP, and 256 MiB for the bot including a 160 MiB V8 heap.
These are ceilings, rather than reservations; probes add a temporary 256 MiB
container, or 512 MiB for the initial Java compilation. Recheck actual peak
memory and source decoding before increasing concurrency.

Loopback health routes are `/live` (process responsiveness), `/ready` and
`/health` (Discord plus audio readiness), and `/status` (aggregate player counts).
Diagnostics contain no guild or user IDs, titles, or signed URLs. Startup checks
configuration before login. SIGTERM/SIGINT stop recovery retries, gate new music,
drain requests, flush the library, close connections, and exit within ten seconds.
A fatal exception or unhandled rejection exits with failure so Docker can recover.

The optional deployment workflow remains gated by `DEPLOY_ENABLED=true` and VPS
SSH secrets. It accepts successful **main-branch push CI** only and deploys that
run's exact SHA. An older CI result cannot roll the VPS back over a newer commit.
It waits for an idle queue, records the current commit, tested runtime YouTube
pin, and actual image IDs in a private durable journal, then builds the exact
release bot image. Audio images remain the recorded images; a release never
silently pulls a newer Lavalink or cipher tag. Source-image/plugin updates need
their own decoded-playback validation.

The idle lease is reacquired and checked again after the build, immediately
before changing running services. If a long build let another session start,
release aborts and restores files while the previous bot keeps playing. A failed
build likewise restores only files and leaves the healthy stack running.

WARP-related Compose/script changes stop audio dependents and recreate WARP,
cipher, and Lavalink together. A Lavalink config change recreates only Lavalink.
Two full canaries must decode nonzero audio through `FINISHED` before command
registration and bot startup. Registration runs from the release image and
failure blocks the release. Bot readiness and exact image/commit identity must
then pass. A failed deployment restores the previous commit, config, runtime
override, image IDs, and command catalog. Rollback also protects a newly active
session and is limited to two attempts.

The tested deploy driver is saved outside Git so it survives rollback to a commit
that predates V2. After interruption, inspect the private deployment journal and
confirm no session is active, then restore with:

```bash
python3 /var/lib/vybertron-recovery/deploy-driver.py rollback --repo /root/Vybertron
```

Resolve the deployment journal before resuming automatic recovery. Previous
images are deliberately retained; use a reviewed retention policy instead of
pruning them during release. A routine isolated audio check is available with
`python3 ops/recovery.py probe`, or add `--full` to decode both complete canaries.
This check never joins Discord voice, sends notices, or changes the plugin.
