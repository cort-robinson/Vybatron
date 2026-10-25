# Moving production to the home server

The runbook for ADR-0010. **Stage** runs while the VPS keeps serving and has no
downtime. **Cutover** is about 15–30 minutes without music and needs the owner's
explicit approval for each production step (VPS commands, secrets, variables,
Deploy re-runs). **Roll back** returns to the VPS during the standby period.

Placeholders: `<vps>` is however you reach the VPS as root over SSH, `<tailnet>`
is the tailnet's MagicDNS suffix, `<home-ip>` is the home server's tailnet IPv4.
Never commit their real values. Run the home commands as root (`sudo -i`). If
root there can't reach the VPS, run each `ssh <vps> …` from your own account and
pipe its output into `sudo sh -c 'umask 077; cat > FILE'`.

Two bots logged in with the same token both answer commands. **Never start the
home bot while the VPS bot is running.** Stage creates the home bot container but
doesn't start it.

## Host readiness

Checked on the home server on 2026-10-24:

| Item | State |
|---|---|
| 16 GiB RAM, 6 cores, 186 GiB free | ok |
| Sleep, suspend and hibernate targets | masked |
| Disk unlock at boot | none needed, so reboots are unattended |
| Docker 29.9, Compose 5.6, cgroup v2 | enabled at boot |
| sshd | key-only. Tailnet traffic is accepted before ufw |
| WARP, cipher and Lavalink | healthy from the home network (WARP on) |
| Bot image build | ok |
| Decoded canaries | not run yet: they need the production YouTube credentials |

Owner checks that only hardware can answer:

- **Power-on after a power cut.** With the bot idle, unplug the machine, plug it
  back in, and confirm it boots without the power button. If it doesn't, plan
  on a UPS or a manual restart after outages.
- **UPS** (recommended). Even a small one rides out the short cuts that would
  otherwise end a session.

## Owner setup (tailnet and GitHub)

1. **Tailnet policy.** Add the tags, a grant that lets deploy runners reach only
   the home server's SSH, and Funnel for the portal node. If the policy still has
   the default allow-all rule, replace it with explicit grants first, because
   `src: *` includes tagged nodes.

   ```jsonc
   "tagOwners": {
     "tag:ci": ["autogroup:admin"],
     "tag:vybertron-portal": ["autogroup:admin"],
   },
   "hosts": { "vybertron-home": "<home-ip>" },
   "grants": [
     // Your own devices keep reaching each other.
     { "src": ["autogroup:member"], "dst": ["autogroup:self"], "ip": ["*"] },
     // Your devices reach the portal over the tailnet: with MagicDNS they use
     // its tailnet address, not Funnel.
     { "src": ["autogroup:member"], "dst": ["tag:vybertron-portal"], "ip": ["tcp:443"] },
     // Deploy runners reach the home server's SSH and nothing else.
     { "src": ["tag:ci"], "dst": ["vybertron-home"], "ip": ["tcp:22"] },
     // Nothing grants tag:vybertron-portal outbound access.
   ],
   "nodeAttrs": [
     { "target": ["tag:vybertron-portal"], "attr": ["funnel"] },
   ],
   ```

2. **Key expiry.** Disable key expiry for the home server's own node in the
   admin console. Otherwise Deploy loses SSH when it expires. Tagged nodes have
   no expiry.
3. **OIDC trust credential** (Settings → Trust credentials → OpenID Connect,
   issuer GitHub). Subject `repo:<owner>/<repo>:ref:refs/heads/main`, scope
   `auth_keys` (write), tag `tag:ci`. Keep its client ID and audience for
   cutover; they become repository variables, not secrets.
4. **Portal node auth key** (Settings → Keys). One-off, not ephemeral,
   pre-approved, tag `tag:vybertron-portal`. It's used once, at cutover.

## Stage (no downtime)

Merge this preparation to `main` first. Deploy needs its *Join the tailnet* step,
and the release staged below must contain `ops/portal-funnel/`. Without
`TS_OAUTH_CLIENT_ID` that step is skipped, so the merge deploys to the VPS as
usual. Stage after that deploy finishes.

The checkout is already at `/root/Vybertron`. Refresh it and create the private
directories:

```bash
cd /root/Vybertron && git fetch origin && git checkout --detach origin/main
install -d -m 700 /var/lib/vybertron-recovery /var/lib/vybertron-portal /var/lib/vybertron-backups
```

Copy the private configuration. This only reads from the VPS, but it is still a
VPS command, so get approval:

```bash
umask 077
ssh <vps> cat /root/Vybertron/.env > /root/Vybertron/.env
ssh <vps> cat /var/lib/vybertron-portal/portal.env > /var/lib/vybertron-portal/portal.env
ssh <vps> cat /var/lib/vybertron-recovery/settings.json > /var/lib/vybertron-recovery/settings.json
ssh <vps> python3 /root/Vybertron/ops/recovery.py status   # note any "override"
SHA=$(ssh <vps> "docker inspect --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' vybertron-bot")
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] && test -f /root/Vybertron/ops/portal-funnel/compose.yml || echo 'stop: bad revision or old checkout'
```

Keeping `PORTAL_SESSION_SECRET` keeps existing portal sign-ins valid after the
move. If `status` shows an `override` (a runtime YouTube pin), copy the VPS's
`lavalink/application.yml` after the checkout below, and write the same object to
`/var/lib/vybertron-recovery/state.json` as `{"override": {...}}` (mode 600) so
later releases reapply it.

Check out and build exactly the running release. Later releases replace these
images with the ones CI tested.

```bash
cd /root/Vybertron && git checkout --detach "$SHA"
docker build --label "org.opencontainers.image.revision=$SHA" -t "vybertron-bot:sha-$SHA" .
docker build --label "org.opencontainers.image.revision=$SHA" -f portal/Dockerfile -t "vybertron-portal:sha-$SHA" .
export VYBERTRON_RELEASE="sha-$SHA"
vc() { docker compose --project-name vybertron --env-file /root/Vybertron/.env \
  --env-file /var/lib/vybertron-portal/portal.env -f docker-compose.yml \
  -f docker-compose.portal.yml --profile portal "$@"; }
vc config --quiet
```

Start the audio services, build the device audio plugin, and create (don't
start) the bot, which the probe inspects:

```bash
vc up -d --wait lavalink
lavalink/plugins/build.sh
vc up -d --wait --no-deps --force-recreate lavalink   # loads vybatron-audio.jar
vc create --no-build bot                               # created, not started
python3 ops/recovery.py probe --full
```

**Gate:** the probe must print `"ok": true` with both tracks ok. If it doesn't,
stop here. The VPS is untouched. Leave the audio services running; they don't
use Discord.

## Cutover

Choose a quiet time. Each step below that touches the VPS, GitHub or Deploy
needs approval.

1. **Pause deploys**, and make sure none is running:

   ```bash
   gh variable set DEPLOY_ENABLED --body false
   gh run list --workflow Deploy --limit 3
   ```

2. **Recheck what was staged.** Read the VPS revision again (as in Stage), and
   rerun `recovery.py status` there. If the revision isn't the staged `$SHA`, or
   the `override` changed, a release landed after staging. Restage with the new
   revision (checkout, both builds, `vc create --no-build bot`, and the canary
   gate) before stopping anything, so older images never start on newer data.

3. **Stop the VPS** once `/maintenance` reports `busy: false` and `inFlight: 0`
   (same check as Deploy). Take the final backup after the bot stops, so nothing
   changes after it:

   ```bash
   ssh <vps>
   touch /var/lib/vybertron-recovery/paused
   systemctl disable --now vybertron-recovery.timer vybertron-backup.timer
   flock /run/lock/vybertron-maintenance.lock docker stop vybertron-portal vybertron-bot
   python3 /root/Vybertron/ops/backup.py backup        # note the bot-data-… name
   umask 077; tar --numeric-owner -czf /root/portal-data.tgz \
     -C "$(docker volume inspect -f '{{.Mountpoint}}' vybertron_portal-data)" .
   docker stop vybertron-lavalink vybertron-yt-cipher vybertron-warp
   tailscale funnel --https=443 off
   ```

   The containers stay stopped across reboots (`unless-stopped`). Nothing is
   removed.

4. **Move the data** to the home server and restore it. In a new shell, set
   `VYBERTRON_RELEASE` and `vc` again as in Stage:

   ```bash
   B=bot-data-YYYYMMDDTHHMMSSZ
   ssh <vps> tar -C /var/lib/vybertron-backups -cf - "$B" | tar -C /var/lib/vybertron-backups -xpf -
   (umask 077; ssh <vps> cat /root/portal-data.tgz > /root/portal-data.tgz)
   cd /root/Vybertron && python3 ops/backup.py verify --name "$B"
   python3 ops/backup.py restore --name "$B"
   vc create --no-build portal
   tar --numeric-owner -xzpf /root/portal-data.tgz \
     -C "$(docker volume inspect -f '{{.Mountpoint}}' vybertron_portal-data)" && shred -u /root/portal-data.tgz
   vc up -d --no-build --wait
   docker ps --filter name=vybertron- --format '{{.Names}} {{.Status}}'
   ```

5. **Move the portal address.** In the admin console, rename the VPS machine
   from `vybertron` to `vybertron-vps`, so the name is free. Then start the
   sidecar with the auth key typed in, never pasted into a command line:

   ```bash
   read -rs KEY && printf 'TS_AUTHKEY=%s\n' "$KEY" > /var/lib/vybertron-portal/funnel.env && unset KEY
   chmod 600 /var/lib/vybertron-portal/funnel.env
   docker compose -f /root/Vybertron/ops/portal-funnel/compose.yml \
     --env-file /var/lib/vybertron-portal/funnel.env up -d
   docker logs -f vybertron-funnel        # until it reports Running
   rm /var/lib/vybertron-portal/funnel.env
   tailscale status | grep vybertron      # the new node is "vybertron", tagged
   ```

   Public DNS for `vybertron.<tailnet>.ts.net` can take a few minutes to follow
   the new node. Check it from a phone on mobile data.

6. **Recovery and backups** on the home server:

   ```bash
   cd /root/Vybertron && python3 ops/recovery.py check
   install -m 644 ops/vybertron-recovery.service ops/vybertron-recovery.timer \
     ops/vybertron-backup.service ops/vybertron-backup.timer /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now vybertron-recovery.timer vybertron-backup.timer
   ```

7. **Point Deploy at the home server.** Create a deploy key that only works from
   tailnet addresses and without a terminal. Set the secrets from your user
   account (`gh` is signed in there), then delete the private key:

   ```bash
   sudo ssh-keygen -q -t ed25519 -N '' -C vybertron-deploy -f /root/deploy-key
   sudo sh -c 'install -d -m 700 /root/.ssh && printf "from=\"100.64.0.0/10,fd7a:115c:a1e0::/48\",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty %s\n" "$(cat /root/deploy-key.pub)" >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys'
   sudo cat /root/deploy-key | gh secret set VPS_SSH_KEY
   sudo shred -u /root/deploy-key /root/deploy-key.pub
   gh secret set VPS_HOST --body '<home-ip>'
   gh secret set VPS_USER --body root
   cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub | gh secret set VPS_HOST_KEY
   gh variable set TS_OAUTH_CLIENT_ID --body '<client id>'
   gh variable set TS_AUDIENCE --body '<audience>'
   gh variable set DEPLOY_ENABLED --body true
   ```

   Re-run the latest Deploy run (approval required). It joins the tailnet, pins
   the host key, reads the running revision over SSH, and reports nothing to
   release. That proves the path before the next merge needs it.

8. **Verify:** every container is healthy, `python3 ops/recovery.py status`
   reports healthy after its first timed run, the manual listening check
   (ops/README.md) passes on desktop and phone, the portal signs in from mobile
   data, device audio plays, and an existing portal sign-in still works.

## Day to day on the home server

- Reboot or update only when idle. Docker restarts the stack at boot, and
  recovery checks it two minutes later:

  ```bash
  sudo docker exec vybertron-bot node -e "fetch('http://127.0.0.1:3000/maintenance').then(r=>r.json()).then(console.log)"
  ```

- Development shares this Docker daemon. The production project is `vybertron`,
  and a checkout in a directory named `Vybertron` defaults to that same project
  name. Never run the production Compose stack from a development checkout here,
  never run `docker compose down -v`, and never run `docker system prune
  --volumes` or `docker volume prune`. Develop the audio stack on another machine
  or in rootless Docker.
- Schedule an off-box backup copy (ops/README.md, *Copy backups off the VPS*) to
  another machine or an encrypted external drive. The daily backups otherwise sit
  on the same disk as the data.

## Roll back to the VPS

During the standby period, if the home server can't serve:

1. Pause the home server: `touch /var/lib/vybertron-recovery/paused`, disable
   both timers, then `flock /run/lock/vybertron-maintenance.lock docker stop
   vybertron-portal vybertron-bot`, stop the audio containers, and run `docker
   compose -f ops/portal-funnel/compose.yml down` (keeping its volume).
2. To keep what changed since cutover, take a home `backup.py backup`, copy it to
   the VPS's `/var/lib/vybertron-backups/`, and `restore` it there with the VPS
   bot stopped. Move `portal-data` the same way.
3. In the admin console, rename the home portal node to `vybertron-home` and the
   VPS back to `vybertron`. Then, on the VPS, run `tailscale funnel --bg 3001`.
4. On the VPS: `docker start vybertron-warp`, then `docker start
   vybertron-yt-cipher vybertron-lavalink vybertron-bot vybertron-portal`, `rm
   /var/lib/vybertron-recovery/paused`, and re-enable both timers.
5. Point the deploy secrets back at the VPS. Its old deploy private key lived
   only in the `VPS_SSH_KEY` secret, so add a new key to the VPS's
   `authorized_keys`, and delete the two `TS_*` variables (or grant `tag:ci` the
   VPS's tailnet SSH port).

## Decommission

After about two weeks without a rollback: cancel the VPS, remove its node from
the tailnet, and update the docs that still describe the VPS (ops/README.md,
docs/portal-operations.md, AGENTS.md, README.md), including the 2 GiB sizing
notes.
