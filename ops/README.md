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
