---
name: Vybatron Portal
description: An album-reactive receiver for a shared Discord listening session.
colors:
  ground: "dynamic, OKLCH L .14 tinted toward the cover's lead hue; default #0d0f14"
  accent: "dynamic, cover lead hue at OKLCH L .81, C .09-.17; default #5fdcd2"
  glow-1: "dynamic, cover lead hue at L .46"
  glow-2: "dynamic, second cover hue at L .38"
  glow-3: "dynamic, third cover hue at L .32"
  text: "#f5f4f8"
  text-soft: "#e2e0e8"
  muted: "#aaa8b5"
  line: "rgb(255 255 255 / .09)"
  line-strong: "rgb(255 255 255 / .15)"
  primary-ink: "#0a0b0f"
  favorite: "#ff5c8d"
  amber: "#ffb84d"
  red: "#ef5156"
  danger: "#c2333c"
typography:
  display:
    fontFamily: "Archivo Variable, sans-serif"
    fontStretch: "116%"
    fontWeight: 800
    letterSpacing: "-0.03em"
  wordmark:
    fontFamily: "Archivo Variable, sans-serif"
    fontStretch: "125%"
    fontWeight: 800
    letterSpacing: "0.06em"
    textTransform: uppercase
  body:
    fontFamily: "Archivo Variable, sans-serif"
    fontSize: "16px"
    fontWeight: 450
    lineHeight: 1.6
  numerals:
    fontFamily: "Archivo Variable, sans-serif"
    fontStretch: "116%"
    fontVariantNumeric: tabular-nums
rounded:
  row: "14px"
  artwork: "8px"
  control: "12px"
  menu: "14px"
  sleeve: "18px"
  panel: "20px"
  dialog: "22px"
  pill: "999px"
---

# Design System: Vybatron Portal

## Overview

**Creative North Star: "The receiver that lights up with the record."**

The portal is a hi-fi receiver for a shared Discord session. The current cover relights
the room: three soft light pools and the single accent are derived from the artwork, and
they glide to the next cover's colors when the track changes. A VFD-style segmented
spectrum glows behind the player deck and under the expanded cover. Smoked-glass chrome
lets the room light through without letting content ghost through.

Audio never reaches the browser, so the spectrum and lighting are generated per track,
never measured. They make no sync claim and carry no text that implies one.

## Color

- **Accent (dynamic):** primary actions, selected navigation, progress, elapsed time,
  focus rings, active toggles, and the spectrum. Derived in `src/art.ts` from the cover's
  most prominent chromatic hue, fixed at OKLCH L .81 so dark ink on accent and accent on
  ground both clear WCAG AA. Monochrome covers produce a quiet near-white accent. Covers
  whose host blocks CORS fall back to the default teal; the blurred cover itself still
  tints the expanded view.
- **Ground and glows (dynamic):** a graphite ground faintly tinted toward the cover, with
  three cover-hued radial light pools behind everything. Browse state keeps them dim
  enough for muted text; the expanded sleeve brightens them.
- **Fixed state colors:** rose for favorites, amber for pause, Warm, recovery, and
  offline attention, red for unavailable and destructive actions. These never follow the
  artwork, so state stays recognizable with any cover.
- Colors are registered `@property <color>` values transitioned on `:root`; the
  spectrum canvas eases toward the same accent.

## Typography

Archivo Variable, self-hosted, one family across two widths. Display headings, the
expanded track title, and the uppercase wordmark use expanded widths (116-125%) for a
faceplate voice. Body and list text stay at normal width. Timeline, durations, indexes,
and counts use expanded tabular numerals; elapsed time is accent-colored like a display
readout. Queue column labels are the only small uppercase text. Minimums are unchanged:
16px primary and 14px secondary text.

## Layout

Desktop: fixed sidebar, 114px topbar, and a 104px single-row deck. The deck's three zones are
identity (56px cover, title, artist, heart) on the left; the transport centered over the timeline,
whose 44px seek target tucks 8px under the transport row, 18px below the deck top so the
skin rings around the play button stay clear of the edge; and volume, filter, More, and a 44px
open/close toggle on the right. The open sleeve keeps the same deck without the identity zone,
so the transport never moves. Pending and syncing notes float in a pill just above the deck's
center (toasts rise to clear it). At 1023px and below: one 72px server header (waveform mark,
server picker, a single status line with voice room and listeners, and the Add music button),
a 72px compact player whose progress is a passive hairline, and 64px bottom navigation. Phones
open to three control rows (timeline, transport, volume with filter and More); on phones 700px
or shorter the sleeve drops its spectrum strip and tucks the seek bar under the transport so the
cover keeps its room, and Overdrive puts the caption on a smoked plate where the sun rises behind it. Tablets (600px
and wider) add favorite and restart to the compact deck, and open to two rows: the timeline
across the top, then volume, transport, and filter with More, which lets the cover grow to 640px.
The page title stays for assistive technology only. Voice room and listeners appear once, in the
server header (plus the desktop listener avatars). The expanded sleeve keeps its 52:48 artwork and Up Next grid.
The cover and its spectrum share one container-query size (`--cover`), so the display
strip always matches the cover width. Short landscape phones hide the sleeve spectrum.

## Materials and depth

- **Chrome:** sidebar, player deck, expanded footer, and the Up Next panel use the ground
  at 62-74% opacity with a 28px backdrop blur. Elements that contain fixed-position
  descendants (the phone header, the landscape expanded footer) drop the blur so they do
  not become containing blocks.
- **Rows:** open rows with faint hairline separators and a rounded hover fill; no cards.
- **Shadows:** offset and soft. The sleeve cover casts a shadow tinted by glow-1; primary
  controls carry an accent-tinted lift on hover.

## Spectrum

`src/components/Spectrum.tsx` draws segmented columns on a canvas: lit segments with a soft
phosphor blur, a falling peak cap, and dim ghost segments (sleeve and sign-in only; the
player deck omits ghosts so it does not read as stripes behind text). Motion is seeded from
the track id and combines per-band oscillation, a slow swell, and irregular low-band
transients; it is not tempo-locked. It runs at about 30fps only while playing, connected,
visible, ambient motion is on, and reduced motion is off. Pause or disconnect decays to a
one-segment baseline and stops drawing. Without motion it renders one still frame.

## Motion

One authored moment: the room relighting on track change (accent 1.2s, glows 2.2s). Light
pools drift over 38-58s only while playing. The sleeve rises in once, and menus, dialogs, and
toasts use short ease-out entrances. Reduced motion removes drift, spatial entrances, and
hover lifts while keeping color changes and the static pending mark.

No frame may flash. Every change either glides or dissolves, and nothing ever drops to empty in
between (tests/smoothness.spec.ts guards the first and last rules):

- View transitions crossfade the page in equal, linear halves (240ms; 420ms for a look, lighting,
  or performance change). Unequal halves leave both snapshots partly transparent and dim the
  whole screen.
- Outgoing and incoming views overlap (170ms out, in from 20ms) so the content area never empties.
- Song changes keep the old cover until the new one has decoded, then dissolve it over 620ms on an
  even curve. The blurred cover light crossfades layers only after the next image decodes, and it
  leaves with the sleeve instead of fading out at full-screen size.
- The palette holds through a gap of up to 1.5s with no artwork instead of resetting to default.
- Anything the travelling cover uncovers is shaded: Overdrive keeps a plate behind the cover and
  dims the sun at once when the sleeve closes.

## Components

Confirmation toasts clear themselves after 4.5s; error toasts stay until dismissed. Toasts
sit above the compact player, and under the topbar/header while the sleeve is open, so they
never cover the current identity. With no current song the player shows an empty sleeve tile
rather than the bundled cover, and empty states use an accent-tinted icon tile. The expanded
title, heart, artist and context are centered as one unit beneath the cover.

Buttons are 12px-radius; primary uses accent with dark ink. The filter control and pills are
full-round. Inputs use a faint white field and a 1px line that brightens on hover and turns
accent on focus. Navigation selection is a soft fill with an accent icon and a short accent
indicator: vertical on desktop, a bottom bar on phone. Menus and dialogs sit on a raised
ground with a strong line and a deep shadow.

## Behavior

### Persistent player and shared queue

The player has one identity, one timeline, and one transport in either composition. Current favorite sits beside the title when visible. Seek is disabled for streams, absent/zero duration, recovery/unavailable state, or lack of control permission. Paused transport uses amber. Controls and selected filter mirror the API snapshot; elapsed playback display interpolates only while playing with live state.

Upcoming rows exclude the current track. Drag reorder captures guild and revision; row menus offer Move up/down and removals. Queue favorite saves use a one-based position and snapshot revision, separate from voice-bound playback controls. The compact expanded queue and the phone queue move the favorite into the row menu. Autoplay picks (`session.suggestions`) render after the queue as a separate Suggested group: same row geometry, an accent radio mark instead of a number, and "Autoplay pick" in place of the requester, which also marks promoted picks and the current pick. Rows offer Add to queue (a direct button on desktop; menu-only in the one-action-column layout at 1023px and below), Less like this, Start radio, and Remove suggestion. Queue, favorite, history, and search rows offer Start radio from this song. Player More toggles autoplay for the session and offers Less like this for the current pick. Player More exposes Save session as mix and Clear upcoming queue with confirmation that the current song, position, and playback state continue; Stop separately confirms clearing playback and discarding the checkpoint, and offers to save the session as a mix first.

### Home

Home is the landing surface, first in navigation. Five shelves in order: Continue listening,
On repeat in this server, Your mixes, Rediscover, Forgotten gems, then a quiet "Your request
stats" section with Clear my request stats. Each shelf is a wide heading, one sentence saying
what it is, and one row that scrolls sideways with proximity snap (no snap under reduced motion).
Track cards are square artwork, title, artist, a muted detail and an accent Add button; ranks on
On repeat sit on the artwork (top three in accent). Playlist tiles in Your mixes use a 2x2 cover
collage, a wide title, song count and length, a one-line explanation, Play (primary) and a
Shuffle icon button; Your top tracks carries its time-range select. Continue listening leads
with the live session (Open player) or a saved one (Resume session) on a softly accent-tinted
panel, then recent history. Shelf-level Play all/Shuffle sit in the shelf header.

Stats load only after the first snapshot, on Home activation and range changes, never with live
snapshots. Every shelf has its own empty sentence explaining why it's empty; an unavailable store
replaces the stats shelves with one amber notice while Continue listening keeps working; without
canAdd one permission note explains why actions are disabled. Clearing request stats uses the
standard confirmation, names what is cleared and what stays, then refetches.

The Stop confirmation includes "Keep this session": a mix-name field and "Save mix, then stop".
The queue heading and Player More menu offer Save session as mix on its own.

### Server favorites

My Music's fourth tab shows two ranked lists, On repeat and Forgotten gems, each with Play all
(primary) and Shuffle (secondary) that queue the whole list through `top play` under canAdd.
Rows are open rows with an expanded tabular rank (the top three in accent), artwork, title,
artist, and a muted play count; no requester ever appears. The tab fetches stats when opened
and on Refresh, never with live snapshots. An unavailable store shows the standard error with
Try again; the rest of My Music keeps working.

### Permission, connection, and recovery states

API projections are authoritative: canAdd, canControl, canVote, saved-session canResume, guild admin, and mix canEdit drive availability. Current/queued favorite saves and visible-session mix saves use library access outside voice with a fresh source revision. Ordinary queue additions use canAdd; play-next and history replay require canControl and a fresh revision, including in supplemental forms. Administration never grants a visual bypass of same-voice/DJ rules. Pending mutations disable competing actions, while Stop retains its urgent path.

Settings preserve authorized channel and role dropdowns. When an admin catalog is absent, labeled Music text channel ID and DJ role ID fields show configured IDs and accept known digit-only Discord IDs, bounded to 20 characters. Leaving DJ role ID blank restores everyone-in-voice controls. Helper text explains missing names without requesting private metadata; the bot validates the referenced guild resources.

Connection banners explain stale/offline state and fresh-state recovery. Permission notes explain the useful next step. Loading uses a labeled status spinner; errors use alert text; empty states provide a relevant next action. Reconnect and conflicts fetch fresh state, preserve drafts, and require a deliberate retry. Authorization loss clears protected data rather than leaving a plausible interactive stale view. UI availability is guidance, never a substitute for server enforcement.

Implementation evidence is source-only: `web/src/styles.css`, `App.tsx`, all source components, and `usePortal.ts`, aligned with `PRODUCT.md`, the app surface brief, and the shared contract. This record does not certify live OAuth, deployment, Discord playback, or cross-device integration. Indexed favorite/history actions carry the originally selected item token; mix deletion carries the selected saved version. Conflicts refresh authoritative state and require a deliberate retry.

## Overdrive look

Overdrive is the default look; Classic (Settings → On this device → Portal look) is the
receiver described above, unchanged. Overdrive lives in `src/overdrive.css`, scoped to
`:root[data-skin='overdrive']`, plus aria-hidden scenery in `src/components/Overdrive.tsx`,
so switching looks is one attribute and removing it is two files and their imports.

- **Horizon:** a sliced sunset tinted by the accent, a seeded angular skyline with blinking
  energon windows, and a perspective neon floor that rolls toward the viewer. The horizon
  sits on top of the deck while browsing and rises to 70% in the sleeve, where the cover
  eclipses the sun. Sign-in places the chrome headline on the horizon.
- **Color:** one fixed orchid neon (`--neon`) and sunset orange are scenery and gradient
  partners only. The cover accent still drives every action and state.
- **Plating:** 4/12px alternating radii (true bevels where `corner-shape` is supported),
  targeting brackets on framed panels, gradient rails instead of hairline borders, and a
  chrome wordmark.
- **Alive:** the floor, windows, CRT band, rail pulse, and reactor ring run only while the
  session plays live with ambient motion on. On track change the title locks on with a
  chromatic split while a scan beam crosses the cover. The sleeve cover leans toward a fine
  pointer. On page load the sun rises and the floor and skyline fade in once; the chrome never
  flickers.
- Reduced motion removes all of it except static color and shape; the horizon changes place
  without travelling and the sun only fades.

## Fantastic Four look

Opt-in (Settings → Portal look → Fantastic Four); never the default. A 1960s retro-future
broadcast from Earth-828, after *The Fantastic Four: First Steps*. It lives in
`src/fantastic.css`, scoped to `:root[data-skin='fantastic']`, plus aria-hidden scenery in
`src/components/Fantastic.tsx`, with the same one-attribute switch and two-file removal.

- **Scenery:** dusk sky over a seeded Googie skyline (bullet towers, saucer needles, domes);
  the Baxter Building flies a 4 emblem. A ringed planet tinted by the accent replaces the sun
  and sits behind the sleeve cover. The bay below carries the planet's reflection and Ben-Day
  dots. Kirby krackle and the monorail appear only in the sleeve (krackle also at sign-in), so
  reading pages keep a clear sky.
- **Color:** cream, suit blue, enamel teal, mustard, and Torch flame are scenery and trim only.
  The cover accent still drives every action and state.
- **Material:** capsule controls, suit piping (cream line over blue) instead of hairlines,
  inset trim lines on panels, indicator lamps on navigation, a tick-dial bezel around play,
  and a teal TV set with knobs and curved glass framing the sleeve cover. Michroma (self-hosted)
  is for the wordmark and headings only; names, numbers, and copy stay in Archivo.
- **Caption plate:** in the sleeve, the now-playing title, artist, and any state note sit on an
  enamel plate (inset trim, 80% ground) so the planet, skyline, and bay never run under text. In
  short landscape the side-by-side controls get the same plate.
- **Alive:** starbursts, krackle, windows, the monorail, a Silver Surfer streak, and the Torch
  orbiting the dial run only while the session plays live. On track change the TV rolls the
  new picture open and the title stretches and snaps back. Reduced motion removes all of it,
  and the horizon changes place without travelling (the planet only fades);
  performance mode also drops the comet and water shimmer.

## Performance mode

Settings → On this device → Performance mode (off by default, every look). It sets
`:root[data-performance]`: solid chrome replaces the backdrop blur, the blurred cover light is
hidden, and the scene and spectrum hold still (App.tsx treats it like ambient motion off).
Overdrive also drops its CRT texture, glow filters, and blend layers. Layout, controls, and
playback are unchanged.

Write only the standard `backdrop-filter`; the build adds the `-webkit-` form. When a rule
declares both, the minifier keeps only the last one, which once removed the blur in Chrome and
the phone header's containing-block override.

## Sideways shelves

Home shelves scroll by mouse drag (`src/dragScroll.ts`): a 6px threshold keeps presses as
clicks, the click that ends a drag is swallowed, release flings with decay (none under
reduced motion), and snapping waits until the drag ends. Touch and pen keep native scrolling.
Overflowing shelves fade at whichever edge still has more to show.

## Do's and Don'ts

### Do:
- **Do** preserve the single player across Home, Session, My Music, and Server navigation.
- **Do** derive the accent and room light from the actual cover, with a working fallback.
- **Do** keep favorites, pause/recovery, and destructive states on fixed colors.
- **Do** use server-projected capabilities and fresh state to decide whether an action is available.
- **Do** settle the spectrum and light drift on pause, recovery, disconnection, hidden tabs, and reduced motion.

### Don't:
- **Don't** label the spectrum as live, measured, or synced audio, or tempo-lock it.
- **Don't** add `backdrop-filter` to an element that contains fixed-position descendants.
- **Don't** let room light rise behind reading text in browse state; brighten it only in the sleeve.
- **Don't** duplicate current identity, timeline, or transport between compact and expanded states.
- **Don't** replay an uncertain or stale mutation after reconnect.
