# Portal web

Production React/TypeScript client for the binding [portal contract](../../docs/portal-contract.md).
The bot owns Discord playback and all library writes. A listener who isn't in one of
the server's voice channels plays on **this device** instead; the player's More menu
moves the session between this device and Discord (Play on).

## This device playback

- `src/playback.ts` keeps a private queue in `localStorage` (`vybertron.local`, cleared on
  sign-out) and handles playback commands locally; nothing is sent to the bot's command API.
  The default follows the snapshot's `viewerVoice`, but joining voice never interrupts
  music already playing here.
- Moving to Discord sends `transfer` with the current song, up to 99 queued songs, the
  position, pause, volume and repeat; the bot joins the listener's voice channel and the
  device queue is cleared. If the server already has a session, the portal joins it instead
  and leaves this device's songs paused. Moving here copies the Discord session at its
  current spot; **Move here** also stops it in Discord (needs playback control), **Listen
  here too** leaves it playing.
  Search, favorites, mixes and stats are still read from the bot, and library edits
  (favorite removal, mix deletion) still go to it.
- Audio only, no video: one `<audio>` element plays `/api/guilds/:id/audio/:videoId`,
  Ogg Opus decoded by Lavalink's vybatron-audio plugin (iOS 18.4+ for Opus) and served by
  the bot, from the start while it arrives and by byte range once complete. It keeps playing
  in the background and on the lock screen, with Media Session controls. A song with a
  YouTube link starts inside the tap that asked for it (iOS requires this); songs from
  other catalogs play their closest YouTube match. The next song is warmed in the bot's
  cache while the current one plays. CSP: `media-src 'self'`; no third-party script or frame.
- Discord-only actions (filters, autoplay/radio, vote skip, saving sessions as mixes
  and saved-session resume) are hidden or disabled locally. Saving a favorite from this device
  sends the song's public link through a one-song favorites import, since Discord's player doesn't hold it.

## Development and verification

Node 24.11+:

```powershell
cd portal/web
npm ci
npm run dev
```

Vite proxies `/api`, `/auth`, and `/health` to `http://127.0.0.1:3001`.
Set `VITE_API_PROXY` to a different **development-only** upstream. Production
requests always use same-origin paths and secure cookies; no browser credential config.

```powershell
npx playwright install chromium
npm test
```

`npm test` builds `dist` and runs the tests in parallel against `vite preview`; the
protocol/PWA tests also serve `dist` on an ephemeral loopback port. Set
`PLAYWRIGHT_PORT` if 4178 is taken. If bundled Chromium is unavailable, use an installed system browser:
`$env:PLAYWRIGHT_CHANNEL = 'chrome'` (or `msedge`) before `npm test`.
Tests use independent, explicit synthetic fixtures only in `tests/**`. No fixture
adapter, fake login, or player data is exported into `dist`.

`scripts/prepare-qa-art.mjs` regenerates test-only crops from approved references.
`tests/design.spec.ts` captures desktop, phone, and tablet UI into `.impeccable/review/`
and fails on console errors, overflow, or accessibility findings. `scripts/compare-qa.mjs`
creates source-left/browser-right comparisons.

## Integration notes

- CSRF token comes from bootstrap and is sent on every POST; browser sends no actor,
  role, voice, membership, or maintainer authority fields.
- Sign-out sends a bodyless POST with the CSRF header and no Content-Type. It
  invalidates this device's session while Discord playback continues.
- Real credentialed EventSource; a reconnect performs GET snapshot before enabling
  commands. In-flight reads from before a disconnect cannot re-enable mutations.
- Playback controls apply to the player immediately and are sent in order
  through one per-guild queue; set-state controls coalesce, and queue edits are
  sent only while verified state still shows the targeted tracks
  ([instant controls](../../docs/portal-instant-controls.md)). Other conflicting
  commands carry the revision from the visible intent. A 409 reads both snapshot
  and library before presenting deliberate retry guidance. Older library reads
  are discarded. Mutations are never replayed automatically.
- API errors clear protected data after 401/403/404. A temporary connection failure
  retains a read-only session projection while disabling commands.
- The service worker caches a versioned static shell only. No API, auth, external
  artwork, Discord avatar, search, library, session, or activity responses are cached.
- The installed app is a GET share target (`/share?title&text&url`). The worker
  answers `/share` from the cached shell, so the shared text doesn't leave the
  device once it is installed. The app keeps the first public HTTPS YouTube,
  YouTube Music, Spotify or SoundCloud link, resets the address to `/`, and queues
  it with `play` only after the listener picks a server and taps Add to queue. A
  signed-out share is held in this tab's session storage for the Discord sign-in
  round trip only (ten minutes at most) and removed when it's read back.
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
  Runtime rasters in `src/assets/` (aurora and fallback-cover derivatives) are root-owned.
  Components import images so they get hashed `/assets/` names; `public/` is only for files
  that need a fixed URL (manifest, app icons).

## Load performance

- `npm run build` also writes `.br` and `.gz` copies of text files (`scripts/compress.mjs`);
  the portal server picks one by `Accept-Encoding`. They are not extra precache URLs.
- `index.html` shows a look-neutral loading line (`src/boot.css`) while the script loads, so
  the page isn't blank, and preloads the latin Archivo font. The line sits outside `#root` and
  hides as soon as a look applies.
- The Server and Settings pages are a separate chunk (`src/views.tsx`), fetched when the
  signed-in portal goes idle. If it can't load, the page shows an error that reloads the portal.
- Import icons from `src/icons.tsx`, never from `@phosphor-icons/react`: each Phosphor module
  ships all six weights. After using a new icon or weight, run
  `node scripts/build-icon-set.mjs`; the build fails while the file is out of date.

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
horizontal overflow.
