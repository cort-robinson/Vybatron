---
name: Vybertron Portal
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

# Design System: Vybertron Portal

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

Geometry is unchanged from the October 5 repair: fixed sidebar, 114px topbar, 154px
persistent player on desktop; top server header, 64px bottom navigation, and 108px compact
player at 1023px and below. The expanded sleeve keeps its 52:48 artwork and Up Next grid.
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

Upcoming rows exclude the current track. Drag reorder captures guild and revision; row menus offer Move up/down and removals. Queue favorite saves use a one-based position and snapshot revision, separate from voice-bound playback controls. The compact expanded queue moves its favorite into the row menu. Player More exposes Clear upcoming queue with confirmation that the current song, position, and playback state continue; Stop separately confirms clearing playback and discarding the checkpoint.

### Permission, connection, and recovery states

API projections are authoritative: canAdd, canControl, canVote, saved-session canResume, guild admin, and mix canEdit drive availability. Current/queued favorite saves and visible-session mix saves use library access outside voice with a fresh source revision. Ordinary queue additions use canAdd; play-next and history replay require canControl and a fresh revision, including in supplemental forms. Administration never grants a visual bypass of same-voice/DJ rules. Pending mutations disable competing actions, while Stop retains its urgent path.

Settings preserve authorized channel and role dropdowns. When an admin catalog is absent, labeled Music text channel ID and DJ role ID fields show configured IDs and accept known digit-only Discord IDs, bounded to 20 characters. Leaving DJ role ID blank restores everyone-in-voice controls. Helper text explains missing names without requesting private metadata; the bot validates the referenced guild resources.

Connection banners explain stale/offline state and fresh-state recovery. Permission notes explain the useful next step. Loading uses a labeled status spinner; errors use alert text; empty states provide a relevant next action. Reconnect and conflicts fetch fresh state, preserve drafts, and require a deliberate retry. Authorization loss clears protected data rather than leaving a plausible interactive stale view. UI availability is guidance, never a substitute for server enforcement.

Implementation evidence is source-only: `web/src/styles.css`, `App.tsx`, all source components, and `usePortal.ts`, aligned with `PRODUCT.md`, the app surface brief, and the shared contract. This record does not certify live OAuth, deployment, Discord playback, or cross-device integration. Indexed favorite/history actions carry the originally selected item token; mix deletion carries the selected saved version. Conflicts refresh authoritative state and require a deliberate retry.

## Do's and Don'ts

### Do:
- **Do** preserve the single player across Session, My Music, and Server navigation.
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
