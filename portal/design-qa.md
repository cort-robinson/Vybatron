# Portal design QA

final result: passed (local web QA; root integration gates remain)

## Sources and normalization

Approved Aurora Queue, Luminous Sleeve, and phone references are
`../docs/portal-references/queue.png`, `player.png`, and `phone.png`.
Desktop references measure 1487 × 1058 pixels and normalize to 1488 × 1056 CSS px
at density 1. The phone reference measures 853 × 1844 source pixels, normalized
to 426 × 928 CSS px; the browser capture is
852 × 1856 pixels at density 2, downsampled to 426 × 928 for comparison.
Additional practical sizes: 393 × 852 phone and 820 × 1180 tablet, density 1.
This small reference normalization is disclosed; these are fidelity comparisons,
not claims of pixel identity. The initial packet's assumed phone height was
corrected with actual Sharp metadata before the final reviewer verdict.

Rendered evidence lives in `web/.impeccable/review/`: desktop queue/sleeve,
mobile queue/sleeve, small phone, tablet, search, disconnected state, full source-left/
browser-right comparisons and focused content/control crops. Explicit synthetic
local browser fixtures provide the same named tracks and test-only artwork crops;
no fixtures enter the production build.

## Comparison history

The first valid batched capture found tablet overflow (P2): desktop navigation,
search, and player consumed too much width at 820 px. Fixed by using the phone
navigation/sleeve composition through 960 px. Interaction testing also found a
toast intercepting the player menu (P1) and the account popup extending behind the
player (P1); fixed with nonblocking notifications away from the menu and an
explicit upward account-popup anchor. Post-fix interaction evidence passed.

Initial capture setup errors (hidden lazy-image decode and axe context creation)
were corrected before using those results as QA evidence.

The independent finish reviewer named two material fidelity corrections: P1
overly broad saturated expanded artwork ambience, and P2 current-song heart
alignment. One corrective batch localized the actual artwork field to the sleeve,
reduced blur to retain broad structure, restored dark queue/header/control ground,
and placed the heart beside the title with metadata below. The bounded final
review scored both resolved, with no regressions observed; disposition `ship`
applies to those scored fixes. The full record is
`web/.impeccable/review/finish-review.md`.

## Required fidelity surfaces

- Typography: self-hosted Manrope Variable; closest obtainable geometric UI face.
  Titles, subtitles, and source metadata use one hierarchy. Reference album labels
  are replaced by contract-provided source names, because Track has no album field.
- Spacing: open queue rows, 260 px desktop rail, 114 px header, 154 px persistent
  player; large artwork left and Up Next right in the sleeve. Phone art is centered
  over a single transport/timeline with fixed bottom navigation.
- Tokens: midnight navy, cyan #00c8ff, magenta #f20aa7, amber #ffb84d,
  and red #ed4245. Artwork ambience is actual source imagery and root aurora art.
- Images: real server-projected source artwork and avatar URLs at runtime;
  bundled root fallback on missing/failed art. Synthetic crops exist only in tests.
- Copy: common music actions; plain permission/reconnect/retry guidance. One
  current identity, timeline, and transport per state. No browser audio claim.
- Icons: coherent Phosphor library. No hand-drawn or fake spectrum graphics.

## Verification and review

T3 preview_status and preview_open both reported an unavailable automation host;
the user-authorized headless Playwright fallback uses installed Chrome. Browser
console errors, horizontal overflow, keyboard controls, and WCAG A/AA axe checks
are recorded in `web/.impeccable/review/browser-evidence.json`.
All four viewport classes have zero console errors and zero horizontal overflow;
the expanded-player WCAG A/AA checks have zero axe violations. Both queue and
sleeve states have saved captures.

The production build and 14-test browser suite passed after the visual corrections.
It covers single-player behavior, core commands and revisions, native HTTP SSE,
late-read reconnect races, no mutation replay, 409 deliberate retry, permission
loss, library/settings/schema forms, recovery, reduced motion, and production
static-only service-worker caching/logout. After contract alignment, the latest
production build and all 16 functional/protocol tests passed. New tests prove
queued favorites outside voice, confirmed clear preserving pause/current position,
an already-completed command's uncertain response causing a fresh read with no
replay, and a 22-second public import completing without a short read timeout.
The final run repeats the native HTTP SSE and production PWA/logout checks.
The existing four-viewport capture test remains the visual evidence; no new design
direction or additional visual polish pass followed the closed review.

The Impeccable detector ran once. Its only finding is the 5 px navigation accent
stripe, explicitly present in the approved Queue reference; preserved as pinned
visual authority. App icons have embedded source provenance; root owns the two
runtime illustration rasters and their provenance.

## API/browser integration correction round (2026-10-04)

The approved composition and closed visual finish review are preserved. This round
corrected the actual bodyless logout request, added play-next revision fencing,
required control access for play-next and history replay in dedicated and schema
controls, and restored visible-session mix saves to library access outside voice.
Existing queued favorites, confirmed clear, and the 95-second command deadline
were retained. Generic fields use the returned schemas for queued favorite
positions, favorite-clear confirmation, replay index, and input limits.

Admin settings now retain authorized dropdowns when present and offer labeled
Music text channel ID / DJ role ID inputs when catalogs are absent. Configured
IDs remain visible; inputs accept digit-only strings up to 20 characters, matching
the actual API validator. Channel input is required; blank role clears the DJ
restriction. Schema-generated channel/role fields use the same fallback. No
private catalog exposure or extra maintainer membership policy was added.

`npm run portal:integration` passed (1/1). The browser used actual OAuth routes,
Vite proxy, API, and authoritative bot bridge; only external Discord and Lavalink
boundaries were deterministic fakes. The check proved Secure/HttpOnly __Host
cookies, working pause/resume, bodyless logout, post-logout bootstrap 401, and
continued fake-player playback after logout. This is local integration evidence,
not a live production OAuth or physical-audio claim.

The production build passed. All 21 functional/protocol tests passed in the final
full run (1.3 minutes), using installed Chrome via `PLAYWRIGHT_CHANNEL=chrome` and
`npm test -- tests/portal.spec.ts tests/protocol.spec.ts` from `web/`.
The suite contains the original
16 cases plus five focused regressions: normal short-desktop and phone sign-out,
DJ/revision enforcement at all play-next/replay entry points, source saves outside
voice, and known-ID maintainer administration. Both route and HTTP logout mocks
reject bodies and unnecessary Content-Type and require the CSRF token; the HTTP
fixture also rejects protected reads after logout. New test locator/name issues
were corrected before the final full verification run.

Changed source files: `web/src/api.ts`, `usePortal.ts`, `styles.css`, and
`components/Search.tsx`, `Library.tsx`, `Server.tsx`. Verification changes are in
`web/tests/fixtures.ts`, `http-fixture.ts`, `portal.spec.ts`, and `protocol.spec.ts`;
documentation changes are `web/README.md`, `DESIGN.md`, and this QA record.

One bounded T3 native-preview confirmation checked the new settings fields at
1280 × 720 and 393 × 852 against an explicit local maintainer fixture. Both had
zero horizontal overflow, readable ID fields, and normal pointer access; the phone
role input scrolled into view without forcing a click. Captures are
`web/.impeccable/review/integration-settings-desktop.png` and
`integration-settings-phone.png`, outside production assets. Short-desktop account
logout and phone Server-settings logout passed normal clicks without hiding the
player, so no account layout redesign was needed. The detector's only finding
remains the pinned 5 px navigation accent. The temporary local preview was closed.

The independent bot review's selected-item findings are addressed by the final
contract integration below. Final integrated CI, live OAuth provisioning, Discord
same-voice enforcement and listening, provider imagery, physical phone installation,
and VPS deployment remain root-owned release gates.

## Final selected-item integration (2026-10-04)

The approved composition and closed visual review remain in force. This round
only binds existing controls to the final API/bot selection contract:

- Favorite play/removal rows, current-player removal, desktop queue hearts, and
  expanded queue menu hearts send the displayed favorite's `expectedTrackId`.
- History replay rows send `expectedHistoryId` alongside the existing snapshot
  revision and same-voice/DJ control requirement.
- Dedicated mix deletion captures name and `expectedMixVersion` when its modal
  opens. Supplemental mix deletion also keeps a captured command through its
  confirmation. New SSE/library state cannot replace an old confirmation token.
- Schema favorite/replay indexes and mix names capture identity on user input,
  display the selected title, and retain typed input and identity through refresh
  and disconnect. Explicitly reviewing the current selection or editing the field
  captures a new item for deliberate retry. Unknown selections disable submission.
- HTTP 409 now awaits new snapshot and library reads. Superseded library reads
  are aborted and cannot overwrite fresher conflict data. No mutation is retried
  automatically; old mix confirmations require closing and reopening for a new
  selected version.

`npm --prefix portal/web run build` passed. Using installed Chrome,
`npm --prefix portal/web test -- tests/portal.spec.ts tests/protocol.spec.ts tests/selection.spec.ts`
passed all 34 functional/protocol tests (1.9 minutes): the existing 21 plus 13
focused regressions. The tests inspect exact serialized tokens on every dedicated
and schema action; prove stale favorite play/removal, filtered history on unchanged
revision, and replaced mix confirmations cannot mutate a substitute; retain old
form tokens across refresh/disconnect; and require deliberate fresh selection.
Native HTTP coverage holds the conflict library read and proves controls stay
disabled until both reads complete. A delayed older library response cannot
resurrect stale rows after the new conflict read. Production PWA/logout and
uncertain-completion/no-replay checks also passed.

The 393 x 852 phone schema check uses normal pointer access to remove a favorite
outside voice, with zero horizontal overflow and zero page errors. Its screenshot
is `web/test-results/selection-phone-schema-sel-e8146-side-voice-without-overflow/selection-phone.png`.
No broad render scoring, asset changes, or visual re-ideation was performed.

Root `npm run portal:integration` passed (1/1) on the serial final run. The initial
parallel attempt timed out at the harness's eight-second page-navigation deadline
while builds/browser checks were active; the serial run required no product or
root-harness changes. This exercises actual OAuth, Vite proxy, API, and bot bridge
with deterministic external Discord/Lavalink boundaries. It remains local evidence,
not live OAuth, audible playback, or deployment acceptance.

Changed source: `web/src/types.ts`, `usePortal.ts`, and
`components/Library.tsx`, `Player.tsx`, `Queue.tsx`, `Server.tsx`.
Changed verification: `web/tests/fixtures.ts`, `http-fixture.ts`, `portal.spec.ts`,
`protocol.spec.ts`, and new `selection.spec.ts`. Documentation: `web/README.md`
and this QA record. No other agent-owned source was edited, and no commit or live
write was made.
