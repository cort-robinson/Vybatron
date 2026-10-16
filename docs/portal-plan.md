# Vybatron portal: approved implementation plan

The owner approved implementation and deployment on 2026-10-04, including
parallel GPT-6.1-Sol Fast tasks. The grilling/shared-understanding gate is complete.
Target incremental cost is $0; do not purchase a service during implementation.

## Product and selected visual direction

This is a production portal for existing private Vybatron servers and future
servers the owner deliberately adds. The bot stays private (Public Bot off), so
only maintainers (the application owner and `PORTAL_OPERATOR_IDS`) are offered
the add-to-server link: built by the bot, checked against `DISCORD_CLIENT_ID`
by the portal server.
Audio stays in Discord; the portal controls the existing hardened player.

- `portal-references/queue.png`: selected refined image 1, Aurora Queue. Use for
  queue, favorites and playlist browsing with one persistent bottom player.
- `portal-references/player.png`: selected refined image 2, Luminous Sleeve. The
  same player expands upward into a large artwork view, with desktop queue at right.
- `portal-references/phone.png`: phone adaptation shown with the approved plan.

Do not recreate the rejected third image or restart visual ideation. Remove the
redundant upper now-playing strip. Keep one current-track identity, one timeline
and one control cluster in either state. Keep controls active across navigation.
Dark navy, cyan #00c8ff, small magenta #f20aa7 accent, amber #ffb84d for Warm,
pause/recovery, red #ed4245 for errors. The UI should feel cool, vibey, advanced
and futuristic, yet simple and intuitive. Use precise typography, spacing,
real imagery, a coherent icon library and tactile transitions.

Use optional decorative artwork-tinted ambient motion, quieter while browsing
and richer while expanded. Honor reduced motion and an off setting, settle on
pause/recovery, suspend hidden-tab/view animation. Current Lavalink supplies
playback metadata, not measured spectrum/amplitude. Do not claim beat sync or
add another source/decoder/audio analysis path for this release.

## Access and features

- Discord OAuth sign-in; seven-day per-device sessions, secure cookies and fresh
  trusted Discord checks on protected operations. Never trust browser role,
  membership, voice, channel visibility or maintainer assertions.
- Basic access for members of installed servers. Guild owner and Manage Server
  members administer their guild. The verified maintainer account administers
  configuration and read-only diagnostics in all installed guilds, even without
  membership. Verify identity using application owner or explicit trusted operator
  configuration; never first signup or a display name.
- Preserve existing same-voice and DJ rules for playback, including administrators.
  Libraries and settings are usable outside voice. Channel visibility protects
  session, queue, listener and history data.
- First-release parity: supported search/links/imports, queue/reorder/remove,
  fair queue, voting, repeat/shuffle, pause/resume/seek/skip/stop, volume/filter
  presets, favorites, shared mixes/playlists, radio, history, saved sessions,
  settings and read-only diagnostics. Prioritize live player and queue polish.
- Per-guild administrator-selected music text channel for web-started sessions;
  active sessions reuse their existing controller. Original saved-channel,
  position, pause and Stop-discard behavior must remain correct.
- Responsive browser and installable PWA with full phone/desktop functionality,
  accessible controls, keyboard/focus behavior and complete empty/error/loading states.

## Data and consistency

- One global private favorites library per Discord account, limit 1,000. Merge
  existing guild favorites without silent loss; deduplicate exact public references.
  Preserve existing overflow safely rather than truncating it.
- Shared mixes remain guild-scoped, creator/administrator editable, at current
  limits: 25 mixes per guild, 100 tracks per mix. Queue limit stays 500.
- Persist latest 100 played tracks per guild for at most 30 days, with original
  voice-channel visibility checks. Admin-only successful queue/settings actor
  activity lasts 24 hours; private favorites are excluded.
- Bot is sole authoritative music-data writer. Do not introduce a second process
  writing `library.json`. Use versioned, backed-up, lossless migration.
- Route mutations through existing guild request lanes, maintenance leases,
  player fences and guards. Serialize ordinary additions. Reject stale conflicting
  edits, refresh and retry. Stop remains responsive during slow lookups.
- Browser disconnection preserves typed inputs, disables changes until fresh
  state and never automatically replays stale commands. Portal failure must leave
  Discord audio playing. No fixtures or demo authentication in production.

## Architecture, hosting and delivery

Responsive React/TypeScript frontend, separate resource-limited Node portal
service for OAuth/session storage/static files/API/SSE. Authenticated private
bot bridge owns music mutations and projection. Only publish portal service to
host loopback; existing maintenance and Lavalink remain private. See
`portal-contract.md` for the binding shared endpoint/DTO contract.

Preferred pilot: current VPS plus Tailscale Funnel Personal Free for eligible
noncommercial use, reusable for other personal projects. Funnel is beta;
actual HTTPS, callback, live updates/reconnect, reboot persistence, CPU/RAM and
audio behavior are release gates. Actual Tailscale identity/hostname and Discord
OAuth callback/secret require secure provisioning; none is assumed configured.
Users need no Tailscale client. Paid fallback is only a reusable service within
the discussed $10/month ceiling, presented concretely before a purchase.

Implement bot adapter/data, portal service and UI in parallel with separate
file ownership. Root owns integration/ops/CI, verifies source/runtime and
rollback, then deploys. Do not touch the pinned audio stack without causal need.
The VPS is 2 GiB; measure actual load and respect maintenance/idle gating.
Final pilot is Bot Testing / General, with Windows desktop and phone controls
and listening, automatic track advancement, Warm/seek/pause and checkpoint recovery.

All commits use Conventional Commits. Preserve v2 PR 21 and use a stacked portal
branch. Link each worked/created PR in T3 immediately and verify links at handoff.
