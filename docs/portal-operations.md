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
Tailscale 1.102.4 is installed with a 128 MiB memory and 25% CPU daemon limit.
The VPS has joined the existing personal tailnet as
`vybertron.tailbeae5.ts.net`. Background Funnel forwards public HTTPS port 443
only to `http://127.0.0.1:3001`. The OAuth secret is privately provisioned and the
owner registered `https://vybertron.tailbeae5.ts.net/auth/discord/callback`.
Local verification has passed 385 core tests, 32 API tests, five joined
OAuth/API/bot tests, 34 functional/protocol browser tests, 62 recovery tests and separate
non-root, read-only, 192 MiB container checks that reopen encrypted logins across
container replacement. Independent recovery review confirmed original file
absence, complete manifests, image/volume fences and safe partial-restore retry.
Actual browser integration passes through OAuth, the Vite proxy, the API and the
authoritative adapter with deterministic external-service fixtures. It verifies
that logout invalidates browser access while playback continues. Desktop/phone
layout and accessibility checks pass locally. Selected-item tokens bind favorite
play/removal, history Replay and mix deletion to the displayed item; a conflict
requires fresh library state and deliberate retry. Live deployment and physical
listening remain acceptance gates.
This document is a runbook, not a claim that the portal has passed live acceptance.
