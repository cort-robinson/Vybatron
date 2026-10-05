---
name: Vybertron Portal
description: A private shared listening space with Aurora Queue and Luminous Sleeve states.
colors:
  ground: "#09121f"
  surface: "#101e2d"
  line: "#27394d"
  muted: "#a7bdd8"
  text: "#f5f7fc"
  cyan: "#00c8ff"
  magenta: "#f20aa7"
  amber: "#ffb84d"
  red: "#ed4245"
  primary-ink: "#051522"
  primary-hover: "#39d6ff"
  secondary: "#142739"
  secondary-hover: "#1c354d"
  secondary-ink: "#e8f2ff"
  field: "#111f2f"
  field-line: "#40536c"
  danger: "#bc3039"
  danger-hover: "#d73a45"
typography:
  headline:
    fontFamily: "Manrope Variable, sans-serif"
    fontSize: "36px"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Manrope Variable, sans-serif"
    fontSize: "22px"
    fontWeight: 750
    lineHeight: 1.35
    letterSpacing: "-0.015em"
  track-title:
    fontFamily: "Manrope Variable, sans-serif"
    fontSize: "15px"
    fontWeight: 750
  body:
    fontFamily: "Manrope Variable, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.6
  button:
    fontFamily: "Manrope Variable, sans-serif"
    fontSize: "14px"
    fontWeight: 750
rounded:
  artwork: "3px"
  row: "4px"
  text-button: "7px"
  chip: "8px"
  control: "9px"
  menu: "10px"
  sleeve: "15px"
  circle: "50%"
spacing:
  tight: "7px"
  compact: "9px"
  control: "12px"
  content: "20px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.cyan}"
    textColor: "{colors.primary-ink}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "11px 20px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-ink}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "11px 20px"
  button-secondary-hover:
    backgroundColor: "{colors.secondary-hover}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "white"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "11px 20px"
  button-danger-hover:
    backgroundColor: "{colors.danger-hover}"
  input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "11px 13px"
  icon-button:
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    size: "44px"
  pill:
    textColor: "{colors.muted}"
    rounded: "{rounded.chip}"
    padding: "6px 9px"
---

# Design System: Vybertron Portal

## Overview

**Creative North Star: "Aurora Queue and Luminous Sleeve"**

Aurora Queue and Luminous Sleeve are complementary expressions of one private listening space. Midnight navy carries open, legible rows; cyan makes control easy to find, magenta marks personal favorites, and amber makes pause and recovery understandable.

Real current-track artwork creates a localized, softened atmosphere around the expanded sleeve. The persistent player survives navigation and transforms between compact and expanded composition. Audio stays in Discord; decorative movement never implies measured sound or beat synchronization.

**Key Characteristics:**
- Open rows and quiet tonal separation.
- One current-track identity, timeline, and control cluster.
- Real artwork, restrained luminous depth, and familiar Phosphor icons.
- Desktop and portrait phone compositions with explicit permission and connection states.

## Colors

The palette combines midnight depth with clear luminous controls and small, meaningful state accents. The frontmatter records canonical source values; translucent variants belong to individual materials, not a second palette.

### Primary

- **Control Cyan:** primary actions, selected navigation, progress, focus, and active repeat controls.

### Secondary

- **Favorite Magenta:** filled hearts and the brand icon; it marks personal attachment rather than playback state.

### Tertiary

- **Recovery Amber:** Warm filter indicator, paused transport, saved-session recovery, and offline attention.
- **Error Red:** unavailable status indicator. Destructive buttons use the deeper danger color and explicit confirmation copy; readable errors use pale red or warm text.

### Neutral

- **Midnight Ground:** page and ambient background.
- **Surface Navy:** artwork fallback and layered containers.
- **Slate Line:** row separators and boundaries.
- **Muted Blue:** metadata, helper text, and inactive controls.
- **Soft White:** main text. Field and secondary-control colors preserve visible distinctions from the ground.

**The State Color Rule.** Cyan denotes actions and selected controls; magenta denotes favorites; amber denotes Warm, pause, and recovery. Pair status color with readable text or a familiar icon.

## Typography

**Display Font:** Manrope Variable, sans-serif.
**Body Font:** Manrope Variable, sans-serif.

The variable family supplies precise, compact hierarchy without a separate display face. Phosphor icons accompany readable labels or accessible names; they are not font glyphs.

### Hierarchy

- **Headline:** page headings use the frontmatter headline role; intermediate desktop reduces them to (30px), phone to (25px).
- **Title:** section headings use the title role, reducing to (19px) on phone. Current compact identity uses (17px, 750); queue titles use the track-title role.
- **Expanded identity:** desktop uses (clamp(27px, 3.2vw, 44px), 800, line-height 1.3); phone uses (clamp(24px, 6.2vw, 34px)), with (22px) at the narrowest breakpoint.
- **Body:** explanatory text commonly uses the body role; queue author metadata uses (14px), then (11px) on phone. Descriptions are constrained to roughly 47 to 70 characters per line depending on context.
- **Label:** buttons use the button role; navigation is (15px, 650) on desktop, (10px) on phone. Numeric durations use tabular figures. Small utility captions in the existing build are not a general-purpose type minimum.

**The Single Identity Rule.** Render the current song once per player state, beside its favorite action when that action is visible. Expansion transforms the existing player rather than creating another now-playing strip.

## Layout

Desktop uses a fixed sidebar (clamp(226px, 17.45vw, 260px)), topbar (114px), and bottom player (154px). Main content starts beside the sidebar with open horizontal queue rows; page padding is (32px 24px 70px 37px). Queue columns align index, drag affordance, artwork/title, requester, duration, favorite, and options.

Expanded desktop content occupies the space between topbar and player, in a (56:44) artwork/Up Next grid with a (37px) gap. Cover sizing is bounded by available width and viewport height. Desktop adjustments at (1330px) and (1100px) reduce spacing and metadata density without adding another player.

At (960px) and below, the sidebar becomes a top server header (90px), navigation becomes a fixed bottom bar (72px plus safe-area inset), and the compact player sits immediately above it (103px). Rows drop desktop columns, requester, drag handle, and duration; menu actions preserve keyboard reorder controls. Search remains reachable through Add music. Phone expansion scrolls vertically through cover, centered identity, timeline, transport, and volume/filter controls; the side-by-side Up Next pane is hidden and Back to queue returns to it. Current favorite is hidden in the compact phone state and visible beside the title when expanded. At (360px), narrower padding and smaller identity/transport accommodate the supported minimum body width (320px).

Spacing is contextual rather than a strict arithmetic scale: recurring compact gaps, control padding, and section spacing are recorded in frontmatter. Preserve the spacious queue and denser secondary forms rather than boxing every row.

## Elevation & Depth

Depth combines translucent navy surfaces, fine borders, and diffuse cool light. Rows remain open and mostly flat; menus and dialogs gain structural shadows. The sleeve cover and player carry controlled luminous depth, while blurred actual artwork supplies localized atmosphere behind the sleeve.

### Shadow Vocabulary

- **Player:** `0 -5px 26px #00c8ff12` anchors the persistent desktop rail.
- **Sleeve:** `0 10px 52px #207cf340` lifts the desktop cover; phone uses `0 8px 45px #207cf34d`.
- **Menu:** `0 13px 35px #020a15bb` separates actionable overlays.
- **Dialog:** `0 20px 85px #000916cc` supports modal focus; backdrop uses (8px) blur.
- **Primary hover:** `0 5px 24px #00c8ff23` is a restrained interaction response.

**The Artwork Atmosphere Rule.** Tint the expanded sleeve with its actual current artwork. Keep atmosphere behind content, localized around the cover, and independent of playback authority.

Ambient artwork drifts over (30s), aurora over (24s), both ease-in-out and alternating. Immersive artwork is localized beside the desktop sidebar with (24px) blur and (.34) opacity; phone uses (18px) blur and (.36) opacity. Subtle lowers expanded artwork to (.16). Off hides artwork tint and retains a static subdued aurora. Movement requires live connection, playing state, visible document, enabled preference, and no reduced-motion preference. Paused/recovering/hidden/disconnected states settle. Reduced motion removes ambient animation and reduces other animation/transition durations to (.001ms).

## Shapes

Gently curved controls use the control radius; rows and small artwork remain tighter. Circular avatars and the main play control provide recognizable focal forms. Menus use the menu radius, large sleeve covers and dialogs use the sleeve radius, and the Warm filter is a pill (25px). Fine borders, rather than heavy framing, separate queue and library content.

## Components

### Buttons

Primary cyan buttons carry the main action; secondary navy buttons support reversible choices; deeper red buttons confirm destruction. Standard buttons are at least (45px) high; icon buttons are (44px) square before contextual responsive adjustments. Text buttons are transparent, muted, and at least (44px) high. Hover uses tonal brightening; active buttons move (1px) and icon buttons scale (.94). Focus is a cyan (2px) outline offset (4px). Disabled buttons use opacity (.4) and a not-allowed cursor; do not use that visual state without a real disabled attribute and useful reason nearby or in the control title.

### Chips

The outlined Taking turns pill uses muted text, the line color, compact padding, and the chip radius. It reports fair-queue state rather than acting as an invented filter. Library tab counts are small neutral badges; selected tabs use a cyan underline.

### Cards / Containers

The server selector is a compact tonal card with a fine line and control-radius corners. Shared mixes are artwork-led open tiles, not raised dashboard cards; their cover radius is (10px), and hover brightens imagery over (200ms). Menus and modal dialogs use the depth vocabulary above. Native modal dialogs restore previous focus when closed and support Escape.

### Inputs / Fields

Fields use the field background, field-line border (1px), control radius, and frontmatter padding, with a (44px) minimum height. Placeholder text stays muted and fully opaque. Focus uses the shared cyan outline and caret. Disabled inputs/selects use opacity (.65); ranges use (.45). Search wrappers preserve the border while the inner field is transparent. Error feedback is a readable inline alert or toast with useful text and retry where available, rather than an undocumented red field-border convention.

### Navigation

Desktop selection combines cyan icon/text, tonal fill, and a leading (5px) cyan rail. Phone uses icon-over-label buttons with a lower (3px) marker. The same Session, My Music, and Server destinations remain available; navigating collapses the sleeve but keeps the mounted persistent player and current session. Account access moves from the desktop sidebar into Server settings on phone.

### Persistent player and shared queue

The player has one identity, one timeline, and one transport in either composition. Current favorite sits beside the title when visible. Seek is disabled for streams, absent/zero duration, recovery/unavailable state, or lack of control permission. Paused transport uses amber. Controls and selected filter mirror the API snapshot; elapsed playback display interpolates only while playing with live state.

Upcoming rows exclude the current track. Drag reorder captures guild and revision; row menus offer Move up/down and removals. Queue favorite saves use a one-based position and snapshot revision, separate from voice-bound playback controls. The compact expanded queue moves its favorite into the row menu. Player More exposes Clear upcoming queue with confirmation that the current song, position, and playback state continue; Stop separately confirms clearing playback and discarding the checkpoint.

### Permission, connection, and recovery states

API projections are authoritative: canAdd, canControl, canVote, saved-session canResume, guild admin, and mix canEdit drive availability. Current/queued favorite saves and visible-session mix saves use library access outside voice with a fresh source revision. Ordinary queue additions use canAdd; play-next and history replay require canControl and a fresh revision, including in supplemental forms. Administration never grants a visual bypass of same-voice/DJ rules. Pending mutations disable competing actions, while Stop retains its urgent path.

Settings preserve authorized channel and role dropdowns. When an admin catalog is absent, labeled Music text channel ID and DJ role ID fields show configured IDs and accept known digit-only Discord IDs, bounded to 20 characters. Leaving DJ role ID blank restores everyone-in-voice controls. Helper text explains missing names without requesting private metadata; the bot validates the referenced guild resources.

Connection banners explain stale/offline state and fresh-state recovery. Permission notes explain the useful next step. Loading uses a labeled status spinner; errors use alert text; empty states provide a relevant next action. Reconnect and conflicts fetch fresh state, preserve drafts, and require a deliberate retry. Authorization loss clears protected data rather than leaving a plausible interactive stale view. UI availability is guidance, never a substitute for server enforcement.

Implementation evidence is source-only: `web/src/styles.css`, `App.tsx`, all source components, and `usePortal.ts`, aligned with `PRODUCT.md`, the app surface brief, and the shared contract. This record does not certify live OAuth, deployment, Discord playback, or cross-device integration. Indexed library removals still lack a library revision in the contract; server validation remains necessary and cross-device conflicts are unresolved outside this visual scope.

## Do's and Don'ts

### Do:
- **Do** preserve the single player across Session, My Music, and Server navigation.
- **Do** use server-projected capabilities and fresh state to decide whether an action is available.
- **Do** retain inputs and show useful recovery, conflict, offline, empty, and error messages.
- **Do** use source artwork with the bundled fallback and one coherent Phosphor icon family.
- **Do** settle ambient motion on pause, recovery, disconnection, hidden tabs, and reduced motion.

### Don't:
- **Don't** introduce browser audio, measured spectrum, amplitude, or beat-sync claims.
- **Don't** use client display names, roles, or voice assumptions as permission authority.
- **Don't** replay an uncertain or stale mutation after reconnect.
- **Don't** duplicate current identity, timeline, or transport between compact and expanded states.
- **Don't** make bright accent washes compete with track text or disabled-state explanations.
