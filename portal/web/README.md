# Portal web

Production React/TypeScript client for the binding [portal contract](../../docs/portal-contract.md).
The bot owns all playback and library writes. The browser never plays audio.

## Development and verification

Node 22.12+:

```powershell
cd portal/web
npm ci
npm run dev
```

Vite proxies `/api`, `/auth`, and `/health` to `http://127.0.0.1:3001`.
Set `VITE_API_PROXY` to a different **development-only** upstream. Production
requests always use same-origin paths and secure cookies; no browser credential config.

```powershell
npm run build
npx playwright install chromium
npm test
```

The protocol/PWA tests serve `dist` on an ephemeral loopback port, so build before
testing. If bundled Chromium is unavailable, use an installed system browser:
`$env:PLAYWRIGHT_CHANNEL = 'chrome'` (or `msedge`) before `npm test`.
Tests use independent, explicit synthetic fixtures only in `tests/**`. No fixture
adapter, fake login, or player data is exported into `dist`.

`scripts/prepare-qa-art.mjs` regenerates test-only crops from approved references.
`tests/design.spec.ts` captures desktop, phone, and tablet UI and records console,
overflow, and accessibility findings in `.impeccable/review/`. `scripts/compare-qa.mjs`
creates source-left/browser-right comparisons. See `../design-qa.md` for the bounded review.

## Integration notes

- CSRF token comes from bootstrap and is sent on every POST; browser sends no actor,
  role, voice, membership, or maintainer authority fields.
- Sign-out sends a bodyless POST with the CSRF header and no Content-Type. It
  invalidates this device's session while Discord playback continues.
- Real credentialed EventSource; a reconnect performs GET snapshot before enabling
  commands. In-flight reads from before a disconnect cannot re-enable mutations.
- Conflicting commands carry the revision from the visible intent. A 409 reads
  both snapshot and library before presenting deliberate retry guidance. Older
  library reads are discarded. Mutations are never replayed automatically.
- API errors clear protected data after 401/403/404. A temporary connection failure
  retains a read-only session projection while disabling commands.
- The service worker caches a versioned static shell only. No API, auth, external
  artwork, Discord avatar, search, library, session, or activity responses are cached.
- Filter IDs/labels and supplemental forms come from bootstrap. Settings use
  server-projected channel/role dropdowns when available; otherwise admins can
  enter known Discord IDs as digit-only strings of at most 20 characters. This
  supports verified maintainers outside a guild without exposing private catalogs.
  The bot still validates the referenced server resources and channel access.
- Favorite add without options saves the current track. Queue hearts save the
  visible one-based position with its revision; the bot resolves the reference.
  Saves work outside voice for visible source channels, matching the contract.
- Clear upcoming queue is a separate confirmed action from Stop: it preserves
  the current song, position, pause state, and voice connection.
- Commands wait up to 95 seconds for the API's bounded 90-second public-import
  deadline. Uncertain completion forces a fresh snapshot/library read, reports
  that the action may have completed, and never retries automatically.
- History replay sends `replay({index})` with the selected entry's
  `expectedHistoryId`, matching the contract, even though the
  pre-portal Discord command used `position`. History replay and play-next require
  live same-voice/DJ control and a fresh session revision in both dedicated controls
  and supplemental forms. Ordinary play additions retain their separate add access.
- Current/queued favorite saves and visible-session mix saves use library access
  outside voice, with a fresh source revision. Queuing favorites or mixes follows
  add rules; replay follows control rules.
- Supplemental grouped subcommands are shown with a clear Discord fallback; the
  contract currently has a single `subcommand` string. No grouped shape is invented.
- Favorite play/removal sends the displayed favorite's `expectedTrackId` with its
  one-based index, including current-player and both queue heart entry points.
  Mix deletion sends `expectedMixVersion` captured when confirmation opens;
  receiving newer session or library state cannot replace that captured version.
- Supplemental favorite-index, replay-index, and mix-name forms capture the
  selected library identity when the user edits the field and display its title.
  Refresh/disconnect preserves typed input and the captured identity. After a
  conflict, deliberately review the current selection (or edit the field) before
  retrying. Close and reopen an old mix confirmation to select its fresh version.
  Tokens remain top-level command fields accepted only on their matching actions;
  playable references and all authority still come from the bot.
- Serving static files must preserve root `/sw.js`, manifest, icons, and hashed assets.
  Runtime rasters `public/assets/aurora.png` and `fallback-cover.png` are root-owned.

The root `npm run portal:integration` check passes through real browser OAuth,
Vite, API, and bot bridge with deterministic fakes only at the external Discord
and Lavalink boundaries. It proves Secure/HttpOnly cookies, pause/resume, bodyless
logout, post-logout 401, and continued fake-player playback. Live OAuth provisioning,
mobile installation, real Discord audio, provider compatibility, and VPS resource
gates remain root integration QA.

The final selected-item round passed all 34 functional/protocol browser tests
(the existing 21 plus 13 selection regressions), the production build, and the
real integration check. It covers every selected-item action, shifted favorites,
permission-filtered history with an unchanged revision, replaced mix confirmations,
captured schema selections across refresh/disconnect, held HTTP conflict reads,
and stale library responses. Phone controls use normal pointer actions with no
horizontal overflow. See `../design-qa.md` for evidence and remaining live gates.
