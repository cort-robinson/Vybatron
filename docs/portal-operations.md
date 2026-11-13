# Private portal pilot operations

The portal controls the existing Discord player. Listeners who are not in voice
can also play songs on their own device through the bounded audio route in
[the integration contract](portal-contract.md). The bot owns all music data; the
portal owns only device sign-in sessions. Read the contract before changing
these boundaries.

## Isolation

Use the optional `docker-compose.portal.yml` overlay. The bot bridge is reachable
only on Docker's private `portal-bridge` network and requires its shared secret.
The portal has a separate egress network for Discord OAuth and publishes only
`127.0.0.1:3001`. The existing maintenance endpoint remains loopback inside the
bot. No Lavalink, WARP, cipher or bridge port is exposed by Funnel.

The portal is non-root, has a read-only filesystem, a 192 MiB memory ceiling,
112 MiB V8 heap ceiling, half a CPU, bounded temporary storage and rotating logs.
`portal-data` persists sign-in sessions; `bot-data` remains the single music store.
It now also holds `stats.sqlite` (play statistics, capped at 16 MiB), which keeps the
volume well inside the 64 MiB release snapshot limit. Releases stop the bot before the
snapshot, and the bot checkpoints the stats WAL on shutdown, so the copy is consistent.
Rolling back to a release without stats quarantines `stats.sqlite` with other
candidate-only files. `listening-state.sqlite` (history, activity, checkpoints,
capped at 8 MiB) works the same way: the bot copies its contents into
`library.json` at shutdown, so an older release keeps them after a rollback, and
the next release adopts anything the older one changed (ADR-0009).
`songs.sqlite` (songs and their sources, capped at 32 MiB, ADR-0017) is a cache
of what played and its catalog links: rolling back quarantines it like stats, and
losing it only loses links the bot rebuilds as songs play again. With every store
at its cap the volume is about 61 MiB, inside the snapshot limit.
Build images on the workstation or CI, then transfer the tested images. Avoid
frontend builds on the production host while music and recovery probes are running.

## Secure provisioning

Steps 1 and 2 describe the original VPS, whose own node served Funnel. On the
home server (ADR-0010), the portal has its own tagged node from
`ops/portal-funnel/` instead, and the host's node serves nothing public; see
docs/host-migration.md.

1. Install Tailscale using its official package repository. Join the existing
   personal tailnet with the hostname `vybertron`; retain normal host routing
   and SSH. Do not configure this machine as an exit node or route acceptor.
2. Enable Funnel only for the portal, with `tailscale funnel --bg 3001`. Its
   HTTPS hostname becomes `PORTAL_ORIGIN`, without a trailing slash. Verify
   MagicDNS, HTTPS and the Funnel capability in the tailnet; do not expose a
   filesystem or the bot bridge. Background configuration survives restarts.
   The bot also reads `PORTAL_ORIGIN` to add an "Open web player" link to the
   Discord player.
3. In the existing Vybatron Discord application, register exactly
   `${PORTAL_ORIGIN}/auth/discord/callback` as an OAuth redirect. Copy its OAuth
   client secret into the host's private environment file, never into chat, Git,
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
(Since 2026-10-26 the portal is `https://vybatron.tailbeae5.ts.net`, served by
the home server's Funnel sidecar; docs/host-migration.md.)
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

## Original live portal pilot

On 2026-10-05, both required CI jobs passed for
`cbc2547a707662dbb8e25e7187dc30d45b62a4c6`. The release driver deployed that clean
source's prebuilt bot and portal images while idle. The public pilot is available
at [Vybatron](https://vybatron.tailbeae5.ts.net) (then under the older
`vybertron` name).

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
music file hashes, the auth-volume inventory and the shared audio network namespace
were preserved. The live auth volume was empty at these reboots; actual device-login
recovery remains an owner acceptance check. Startup HTTPS was allowed to settle
before final verification.
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

The owner's first authenticated listening check reached playback and Pause, but
reported recurring unavailable errors, connection loss and unsynchronized state.
The pilot has not passed live acceptance. A read-only private-bridge probe then
reproduced a 503 during repeated fresh permission checks alongside two successful
state reads. Host capacity and audio health stayed normal. Recovery and state
ordering corrections are under verification; no audio service was changed for
this investigation. A portal-only restart has preserved the real encrypted login
record and bot/audio processes since the owner's sign-in. This differs from the
earlier reboots, which had no stored device logins.

The synchronization correction uses bounded parallel permission reads, fresh
pending-only state sharing, independent stream heartbeats and transient read
backoff. The browser keeps an open stream through temporary error frames,
disables controls while stale, and reconciles overlapping command replies with
a read started after completion. Hard permission failures clear protected data;
malformed or oversized upstream payloads terminate their streams. A compiled
two-browser integration now exercises initial read failure, slow Pause, transient
bridge errors on both streams, phone offline/online recovery, and hidden-channel
redaction through the real OAuth/API/adapter boundaries. External Discord/audio
responses are fixtures in this test; it does not establish live acceptance.

Local synchronization verification passed 392 core and 71 API tests. The broad
browser run passed 52 of 54; both remaining cases passed in targeted runs after
correcting keyboard-test sequencing and separating colliding trace output.
The two earlier joined browser integrations and the new two-client regression
also pass. Exact-commit CI must run all browser cases and integrations together
before replacing the pilot; cumulative local runs do not substitute for that gate.

## Live synchronization correction and remaining channel pressure

Both required CI jobs passed for `874b46b3d3e6e4c5b54e148e43a3ecaca2a1eaa7`,
including all 54 browser cases in one run and all three joined browser integrations.
The guarded release driver deployed its clean source and prebuilt images while
idle. The bot image is
`sha256:11a08e5023300e3d4f92410ea514b9484f19899b92b743dca202a60b2c1a1bee`;
the portal image is
`sha256:7f3767c25bc120a913528b3e2ba990e597244d98a2fe01b4ce1254d78be49ee1`.
Both deployment journals completed. The private release audit verified unchanged
music files, both persistent volumes, the real encrypted device-login record,
and the original audio container IDs, images, PIDs and shared network namespace.
Actual public HTTPS desktop/phone rendering, OAuth entry, private-route denial,
PWA shell/font loading and offline/network-only behavior passed again.

A repeated read-only live probe still failed the third native Queue request with
bridge503 while two concurrent snapshots succeeded. Discord's actual response
headers showed a server-wide channel-list bucket of ten reads per sixty seconds;
fresh individual voice/text channel GETs had much greater capacity. These are
observed service limits, not application constants. The fresh policy was fetching
the complete list at every snapshot and command boundary, so browser recovery
alone could not resolve its request demand.

The next correction separates fresh individual authorization of relevant session
and history channels from explicit admin-only configuration discovery. Its scope,
response contract and browser lifecycle are documented in
[`portal-channel-read-contract.md`](portal-channel-read-contract.md).
Preserve fresh permissions, bounded reads, command selection/revision guards,
Stop reservations and no mutation replay. Run exact-source CI and the same live
probe before asking the owner to repeat listening acceptance.

The channel correction now uses pending-only individual reads for ordinary
session/history authorization. Complete channel discovery runs only when an
administrator opens Settings or deliberately refreshes its options. Discovery
failure retains typed channel/role IDs and does not authorize a write. Each
permission stage detaches fresh owner, member-role, role-permission and overwrite
inputs immediately when its REST response settles; native discord.js methods use
those same inputs. Final guild mix replies also respect membership loss, including
idle maintainer requests. Gateway voice movement remains live during these checks.

Local verification on the integrated correction passed one full run of each
suite: 434 bot tests, 74 API tests, 63 desktop/phone browser cases and three joined
browser integrations. The joined two-client case continuously fetches individual
channels while every full channel-list call is configured to fail, and verifies
slow controls, temporary outages, offline recovery and permission redaction.
External Discord/audio replies in these tests are synthetic. Independent review,
exact-source CI, guarded deployment and repeated live probes still determine
release readiness; these local results do not establish owner listening acceptance.
An independent closure review reproduced the original mutable-cache permission
grant and idle-maintainer mix reply cases against installed discord.js structures.
Both are closed; 43 focused regressions and three supplemental synthetic probes
passed, with no remaining source blocker found. Deployment and live acceptance
remain separate gates.

Remaining owner acceptance: reliable sign-in on Windows and phone, synchronized
portal controls, audible pause/resume/seek/Warm, queue advancement, device-login
persistence and saved-session restoration. Physical PWA installation is also
distinct from automated browser installability. Record these observations without
collecting login tokens or private favorites.

This document is a runbook, not a claim that the portal has passed live acceptance.

## Direct-control response correction

Web Pause/Resume/Seek/Filter-with-preset/Volume acquire fresh guild authority at
native execution after lane and dispatch waits, then check fresh authority again
before disclosing the result. They carry no admission grant across a wait. Read-only
Filter and catalog/persistence commands retain their existing additional checks.
Independent user/application-owner reads overlap within two admissions; completed
authorization responses are never cached. Same-voice, DJ, revision, selection,
player ownership and Stop rules remain authoritative.

Successful direct controls await the actual playback API, then schedule Discord
controller/status updates through owned writers. Those writers share four ordinary
and two terminal workers, cap busy resources at 256, retain one current and one
latest intent, and hold serialization until actual REST settlement. Stop and idle
disconnect retire presentation ownership immediately and await physical shutdown
and existing saved-data cleanup without waiting for cosmetic REST updates.

Private bridge `/v1/latency` provides bounded numeric timings only to a freshly
verified maintainer with the bridge secret. The portal does not expose it. Playback
API invocation/settlement timings do not prove when audio becomes audible on a
listener's device. Real device responsiveness remains a separate listening check.

## Overlapped authority release

`669962a0dc4e48e4b52510276556ebde598ee2f2` passed both CI jobs and was deployed
with the guarded driver on 2026-10-06. Bot image
`sha256:7753d60737f6ea93de64d29e268b6409680ffa9947e96a9eee1c350fe3f2eac0`;
portal image `sha256:3a9f720a03f502c645f6bc8ca6418c8011d3296e36679e9f160690775e2004cf`.
Audio container IDs, the music-volume digest and the encrypted login store were
unchanged across the release; `5b9b6a3` remains the rollback candidate.

Ordinary playback controls now settle identity first, then read the raw guild,
both members and session channels in one fail-fast wave. Channel prefetch only
runs in session scope when the actor is already in that guild's voice. Urgent Stop
keeps its staged width-two sequence and two reserved admissions. Every input is
still a fresh, detached REST read and no grant is derived until the wave succeeds.

PR #23 (`feat/instant-sync-controls`) then built on this release: one authorization
round for identity, guild and members (Stop included, with an eight-read urgent
reserve and all-or-nothing round admission), instant playback controls, and pushed
Discord-side changes. Its head `82fab8b6021788d76a6f6dd1bf1926867d5ddbe8` has been
live since 2026-10-06 08:31 UTC, so the samples below measure `82fab8b`, not
`669962a` alone.

Owner-maintainer `/v1/latency` samples on `82fab8b` (eight controls): native
authority 297–568 ms (previously 805–954 ms on `5b9b6a3`), readiness for mutation
302–592 ms, and total command time mostly 652–1,000 ms (previously 1,911–2,269 ms).
Two outliers near 1.44 s came from a single slow Discord read or filter application.
The owner reported Pause/Resume "feels way better" on phone and desktop.

## Automatic main releases

`.github/workflows/deploy.yml` releases successful `main` pushes when the repository
variable `DEPLOY_ENABLED` is `true` and `PORTAL_GUILD_ID` names the test guild. It
reads the running bot's revision label and does nothing when that release already
includes the commit. It stops before staging when the running release is not an
ancestor, or when `docker-compose.yml`, `lavalink/`, `warp/` or the playback probe
changed: the portal driver never recreates audio, so those releases need an operator.

Otherwise it downloads the bot and portal images that the main-push CI run built
and tested (never building on the production host), checks both carry the target revision
label, transfers them with a `git archive` of the exact commit, installs that commit's
`ops/portal_deploy.py` and `ops/deploy.py` as the private drivers (keeping the
previous pair as `*.previous`), and runs the same idle-guarded portal driver used for
manual releases. While a session is playing, paused or queued, the job waits: it polls
the bot's read-only `/maintenance` status every minute (never pausing `/play`) and
releases as soon as the bot is idle. If a session starts between the poll and the
driver's own idle lease, the driver refuses before changing anything and the wait
resumes. After 5 hours of continuous listening the job fails without changing
services; re-run it once the session is idle. If the bot's status can't be read for 5 minutes in a
row (bot down, health endpoint failing), the job fails instead of waiting. A release that fails after changing services and then
finds a listener before it can roll back reports `portal_failed_rollback_waiting_for_idle`
and is never retried; it needs an operator. The CI image artifacts expire after a day, so
re-run a failed release within that window or re-run CI first. The job then checks
both containers carry the target revision and report healthy, and deletes the image
artifacts.

SSH trusts only the host key in the `VPS_HOST_KEY` secret (the server's public key
lines without host names, for example `ssh-ed25519 AAAA…`). After rebuilding the
host or rotating its host keys, update that secret from a verified connection.

The portal driver registers commands globally and clears the test guild's
guild-scoped copy, so nothing appears twice. Each transaction backs up both catalogs
(`version: 2`) and rollback restores both; older guild-only backups still restore.
`ops/deploy.py` keeps the bot-only release for hosts without the portal and refuses
with `portal_overlay_requires_portal_driver` wherever a portal container exists.

Automatic recovery is unaffected: it restarts the existing bot container (keeping
its portal environment and network) or recreates only audio services.
