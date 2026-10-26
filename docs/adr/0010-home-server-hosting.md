# ADR-0010: Host production on a home server instead of the VPS

- Status: Accepted (cut over 2026-10-26)
- Date: 2026-10-24

## Context

Production runs on one 2 GiB VPS. The memory ceilings in `docker-compose.yml`
exist because that host ran out of memory (ops/README.md, *Host baseline*), the
portal image can't be built there, and YouTube blocks the VPS's datacenter
egress, which is why WARP carries all audio traffic. The owner has an always-on
home machine with 16 GiB of RAM, six cores and a solid-state disk that already
belongs to the same tailnet. Its sleep and hibernate targets are masked and its
disk needs no passphrase at boot, so it restarts unattended.

## Decision

Move the whole stack (bot, portal, Lavalink, cipher, WARP, recovery and
backups) to the home server and change as little as possible:

- **Same layout.** The checkout stays at `/root/Vybertron` with private state in
  `/var/lib/vybertron-{recovery,portal,backups}` and the Compose project
  `vybertron`. The drivers, systemd units and runbooks work unchanged.
- **Deploys over the tailnet.** The host has no public SSH port. When the
  repository variable `TS_OAUTH_CLIENT_ID` is set, Deploy joins the tailnet as an
  ephemeral `tag:ci` node using GitHub OIDC (no stored Tailscale secret) and uses
  the same pinned-host-key SSH as before. The tailnet policy lets `tag:ci` reach
  only that host's port 22, and the deploy key only works from tailnet addresses.
- **Portal on its own node.** A Tailscale sidecar (`ops/portal-funnel/`) gives
  the portal its own tagged tailnet node and publishes `127.0.0.1:3001` with
  Funnel, so the owner's own node serves nothing public. The cutover kept the
  old name `vybertron`, so sign-ins carried over; the portal then moved to
  `vybatron` to match the project's name, which meant one new sign-in and
  reinstalling the web app.
- **Same audio path.** WARP stays. A residential address might not need it, but
  dropping it is an audio change that needs its own decoded canaries and
  listening check.
- **Reversible.** The VPS keeps its stopped stack and data for a standby period
  (docs/host-migration.md) before it is cancelled.
- **Names kept.** The deploy secrets keep their `VPS_*` names, and the Compose
  project, containers and volumes keep `vybertron`. Renaming them would touch
  production state for no behavioural gain.

## Consequences

- More memory, faster builds and no hosting bill. Compose ceilings stay as they
  are until real usage on the new host justifies changing them.
- Availability now depends on home power and internet. A power cut or ISP outage
  takes the bot offline until both return, and alerts can't be delivered during
  it. The host must power on by itself after a power cut, and a UPS is
  recommended.
- The host is also a personal workstation. Each reboot, kernel or Docker update
  interrupts playback, so reboot when `/maintenance` reports idle. The production
  Compose project, container names and `vybertron_*` volumes share its Docker
  daemon with development: never run the production Compose stack from a
  development checkout on this host, and never prune Docker volumes there.
- The deploy key gives CI root on a personal machine rather than a disposable
  VPS. This is limited by the `tag:ci` grant, the key's `from=` and `no-pty`
  restrictions, and Deploy's existing gates (same-repo `main` pushes with green
  CI only).
- Daily backups sit on the same disk as the data until an off-box copy is
  scheduled.
- Measurements and history that mention the 2 GiB VPS (memory ceilings, ADR-0005)
  stay as written: they record where the numbers came from.
