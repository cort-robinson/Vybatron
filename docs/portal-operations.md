# Private portal pilot operations

The portal controls the existing Discord player. It does not transmit audio to
the browser. The bot owns all music data; the portal owns only device sign-in
sessions. Read [the approved plan](portal-plan.md) and
[the integration contract](portal-contract.md) before changing these boundaries.

## Isolation

Use the optional `docker-compose.portal.yml` overlay. The bot bridge is reachable
only on Docker's private `portal-bridge` network and requires its shared secret.
The portal has a separate egress network for Discord OAuth and publishes only
`127.0.0.1:3001`. The existing maintenance endpoint remains loopback inside the
bot. No Lavalink, WARP, cipher or bridge port is exposed by Funnel.

The portal is non-root, has a read-only filesystem, a 192 MiB memory ceiling,
112 MiB V8 heap ceiling, half a CPU, bounded temporary storage and rotating logs.
`portal-data` persists sign-in sessions; `bot-data` remains the single music store.
Build images on the workstation or CI, then transfer the tested images. Avoid
frontend builds on the 2 GiB VPS while music and recovery probes are running.

## Secure provisioning

1. Install Tailscale using its official package repository. Join the existing
   personal tailnet with the hostname `vybertron`; retain normal host routing
   and SSH. Do not configure this machine as an exit node or route acceptor.
2. Enable Funnel only for the portal, with `tailscale funnel --bg 3001`. Its
   HTTPS hostname becomes `PORTAL_ORIGIN`, without a trailing slash. Verify
   MagicDNS, HTTPS and the Funnel capability in the tailnet; do not expose a
   filesystem or the bot bridge. Background configuration survives restarts.
3. In the existing Vybertron Discord application, register exactly
   `${PORTAL_ORIGIN}/auth/discord/callback` as an OAuth redirect. Copy its OAuth
   client secret into the VPS private environment file, never into chat, Git,
   a browser bundle, screenshots, CI logs or command arguments.
4. Create `/var/lib/vybertron-portal` with mode 700. Use
   `.env.portal.example` as a template for
   `/var/lib/vybertron-portal/portal.env`, mode 600. Generate independent
   `PORTAL_BRIDGE_TOKEN` and `PORTAL_SESSION_SECRET` with Python's
   `secrets.token_urlsafe(48)`. Keep the existing bot credentials in
   `/root/Vybertron/.env`, also mode 600. The maintainer is derived from the
   verified application owner; signing in first grants no extra access.
5. Use both environment files explicitly when operating the overlay. Validate
   configuration without printing the interpolated Compose document:

```bash
docker compose --project-name vybertron \
  --env-file /root/Vybertron/.env \
  --env-file /var/lib/vybertron-portal/portal.env \
  -f docker-compose.yml -f docker-compose.portal.yml \
  --profile portal config --quiet
```

Tailscale Funnel is beta and has bandwidth limits. Its Personal plan is free for
eligible noncommercial use and can serve other eligible personal projects.
Users accessing the public HTTPS portal do not need Tailscale. Do not purchase
a subscription or domain as part of this pilot. Official references:
[Funnel](https://tailscale.com/docs/features/tailscale-funnel) and
[Personal plan](https://tailscale.com/pricing).

## Exact-source release

Finish the bot/API/web checks and CI for the exact candidate SHA before release.
Build both `vybertron-bot:sha-SHA` and `vybertron-portal:sha-SHA` with
`org.opencontainers.image.revision=SHA`, save them outside the source tree, and
load those exact images on the VPS. Deliver a clean source archive to
`/var/lib/vybertron-portal/releases/SHA` with a private `.portal-release.json`
containing `{"revision":"SHA"}`. Keep credentials outside the archive.

Save the reviewed portal driver and its `deploy.py` dependency outside Git in
the private recovery directory so they survive a source rollback. The driver
requires the same maintenance lock as automatic recovery and a fresh idle lease.
Paused/current/queued tracks and in-flight requests block replacement. It backs
up the exact music volume and guild command catalog, registers only the chosen
test guild, and replaces only the bot and portal. It verifies both image
identities, the original writable volume, the original audio container IDs,
and authenticated bridge readiness. It never rebuilds, pulls or recreates audio.

```bash
python3 /var/lib/vybertron-recovery/portal-driver.py deploy \
  --sha SHA --guild-id BOT_TESTING_ID \
  --repo /var/lib/vybertron-portal/releases/SHA
```

The pilot targets Bot Testing / General. Validate real HTTPS sign-in, permission
changes, private favorites, multi-browser synchronization, disconnect/reconnect,
pause/resume, seek, Warm, short-to-next-track advancement and paused two-song
checkpoint recovery. Measure CPU/RAM and audio with multiple clients. Verify
service restart and Funnel persistence; do not reboot an active voice session.
Source decoding alone does not establish audible Discord delivery. Physical
Windows/phone listening is a separate acceptance check.

## Rollback and interruption

`portal-deployment.json` is the private durable transaction. The shared
`deployment.json` marker blocks automatic recovery during an interrupted portal
transaction. Resolve it with the matching portal driver, not the ordinary main
release driver. Original audio images/containers are retained throughout.

```bash
python3 /var/lib/vybertron-recovery/portal-driver.py rollback \
  --repo /var/lib/vybertron-portal/releases/SHA
```

Rollback rechecks idle and refuses to interrupt a newly active or paused session.
Before restoring pre-migration music data, it saves the newer data privately in
`portal-failed-data-*`; keep that backup for reconciliation if users made changes
after release. It restores the original guild command catalog, bot image and
music files, while keeping the same writable volume. Candidate-only files move
to private `portal-rollback-extras-*` folders, preserving original file absence
and keeping the newer files available for reconciliation.
No persistent volume is removed. Rollback permits at most two attempts; unknown
external image/volume changes or a corrupt backup require operator attention.
Both previous and planned image IDs are recorded before replacement. If a failed
recreation leaves no bot container, recovery independently verifies the named
volume, Compose binding and audio containers before restoring the prior bot.
Backups have versioned, complete manifests and journal-bound manifest hashes;
missing or truncated metadata cannot silently skip data restoration. Files are
validated before replacement and hashed again afterward. Whole-volume restoration
is not atomic: a filesystem error leaves the bot stopped and the journal pending
for an explicit retry, with both original and newer private backups retained.

## Current evidence

The live pre-portal inventory on 2026-10-04 confirms healthy Discord/audio, zero
players/queued tracks/failures, bot image
`sha256:8c715847c8fda33b6a042ef56bc2f92070da2b91e01d2af4593d51634bb36d92`,
code revision `4cb73957c906fd8f4954385132538a66488d07cf`, and the existing
`vybertron_bot-data` volume. VPS source checkout is older than that running image;
do not infer runtime identity from its Git HEAD. Available RAM was approximately
688 MiB in the latest idle sample and swap was allocated; remeasure during pilot
load before launch.
Tailscale 1.102.4 is installed. Its final daemon limits are 160 MiB soft memory,
192 MiB maximum memory and 50% CPU. The initial 96/128 MiB limits caused severe
memory reclaim during cold browser downloads. Raising them removed that pressure.
Update the existing `/etc/systemd/system/tailscaled.service.d/vybertron-resources.conf`
override when changing these limits: its filename sorts after the `50-*` files
generated by `systemctl set-property` and otherwise overrides them at reboot.
The corrected limits were checked after an actual subsequent host reboot.
The VPS has joined the existing personal tailnet as
`vybertron.tailbeae5.ts.net`. Background Funnel forwards public HTTPS port 443
only to `http://127.0.0.1:3001`. The OAuth secret is privately provisioned and the
owner registered `https://vybertron.tailbeae5.ts.net/auth/discord/callback`.
Local verification has passed 385 core tests, 34 API tests, five joined
OAuth/API/bot tests, 34 functional/protocol browser tests, 62 recovery tests and separate
non-root, read-only, 192 MiB container checks that reopen encrypted logins across
container replacement. Independent recovery review confirmed original file
absence, complete manifests, image/volume fences and safe partial-restore retry.
Actual browser integration passes through OAuth, the Vite proxy, the API and the
authoritative adapter with deterministic external-service fixtures. It verifies
that logout invalidates browser access while playback continues. Desktop/phone
layout and accessibility checks pass locally. Selected-item tokens bind favorite
play/removal, history Replay and mix deletion to the displayed item; a conflict
requires fresh library state and deliberate retry. Physical sign-in, installation
and listening are separate acceptance checks from these deterministic tests.
The first CI-passing pilot (`d1240e935a55c82c1f1d8eb4296ece2a2d7597e5`)
was deployed while idle. Real HTTPS, public rendering, private-route denial,
exact OAuth redirect/cookie flags, verified maintainer identity and all 26 command
schemas passed. Public production-browser verification found a PWA installation
and font-policy gap, so the pilot was rolled back before listening acceptance.
Live rollback restored the original music file hash and 25-command catalog,
selected the exact previous bot image, retained newer data privately, and kept
the original audio container identities and writable music volume. The previous
bot was ready after rollback. Both installed-source canaries decoded through
`FINISHED`: 946 and 10,866 Opus frames, with expected complete durations.
This isolated probe opened no Discord voice session. The corrected PWA candidate
subsequently passed CI and public browser verification before reopening the pilot.
The correction now passes the compiled production-client integration through
the real static/API server: all 17 shell URLs and six self-hosted font subsets
load under the existing CSP, desktop/phone workers control the page, and the
shell reloads offline without caching authenticated reads or replaying writes.
Both browser integrations and the 34 functional/protocol checks pass locally and
in CI. The live public browser checks below use the actual HTTPS deployment;
physical-phone installation remains a separate check.
The reboot preflight found that the live recovery timer still loaded the older
checkout's monitor, which lacked the reviewed deployment-journal and idle guards.
Only that script was replaced with the CI-passing reviewed version; its hash and
effective timer entry point were checked, and the prior script was retained
privately. Automatic recovery was durably paused during deployment and reboot
verification, then resumed after both complete decoding canaries passed.
Audio configuration, container identities, images and resource ceilings were retained.

## Deployed portal candidate

On 2026-10-05, both required CI jobs passed for
`cbc2547a707662dbb8e25e7187dc30d45b62a4c6`. The release driver deployed that clean
source's prebuilt bot and portal images while idle. The public pilot is available
at [Vybertron](https://vybertron.tailbeae5.ts.net).

The bot runs image
`sha256:4d58234d2d1848754020fd9bf37ec27d0b2e74d765fd9d90acdbfde1a48638dc`;
the portal runs image
`sha256:c1dcbdb3749a99543bb163c185e3a5e97a1e6729728bfcde83c8c51c7b9af685`.
Both image labels identify the candidate SHA. Later documentation commits do not
change these runtime identities. The original music volume, audio images and
audio container identities remain intact. Both deployment journals are complete.

Actual public-relay Chrome checks passed at desktop 1488×1056 and phone 393×852:
the signed-out interface rendered without overflow or page errors; all 17 PWA
shell URLs and six font subsets loaded under the unchanged CSP; the worker
controlled the page and served an offline reload; protected reads required the
network and were never cached. These checks used public Funnel DNS rather than
the workstation's private MagicDNS route. No browser authentication was forged.
The live OAuth entry redirects to Discord with the exact registered callback,
`identify` scope, state and Secure/HttpOnly cookie; anonymous API and bridge reads
are denied. The real private bridge verifies the application owner as maintainer.

Portal-only and Tailscale service restarts passed. The final of two controlled
idle host reboots verified automatic service startup and the corrected Tailscale
limits without manual service starts. Container/image/volume identities,
music and encrypted-login file hashes, and the shared audio network namespace
were preserved. Startup HTTPS was allowed to settle before final verification.
The final controlled check decoded both complete canaries through `FINISHED`:
946 frames at 18,900/18,947 ms and 10,866 frames at 217,300/217,385 ms. Fresh
production readiness, idle state, data hashes and public ingress were checked
again afterward. These isolated checks opened no Discord voice session.
After automatic recovery resumed, its first unattended check reported healthy,
with no pending repair/update, update error or unsent alert.

Post-reboot samples showed about 973 MiB available host RAM, no active swapping,
no container OOM events and zero Tailscale memory-pressure events. Recheck under
two authenticated devices and actual Discord playback before declaring listening
acceptance. Bot Testing's portal music text channel is configured as `general`;
the recovery alert channel was retained separately.

Remaining owner acceptance: real Discord sign-in on Windows and phone, synchronized
portal controls, audible pause/resume/seek/Warm, queue advancement, device-login
persistence and saved-session restoration. Physical PWA installation is also
distinct from automated browser installability. Record these observations without
collecting login tokens or private favorites.

This document is a runbook, not a claim that the portal has passed live acceptance.
