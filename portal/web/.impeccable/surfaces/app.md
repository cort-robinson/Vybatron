---
primary: src/App.tsx
related:
  - src/components/Player.tsx
  - src/components/Queue.tsx
  - src/components/Library.tsx
  - src/components/Server.tsx
  - src/components/Home.tsx
mode: Operate
---

# Shared listening surface

Members should understand the shared queue at a glance, add music without losing
their place, and expand the same bottom player into the approved sleeve view.
The primary action is Add music. The memorable moment is the single cover opening
upward while the same timeline, transport, volume, and filter stay together.

The source comps are `docs/portal-references/{queue,player,phone}.png`; the chosen
direction is already approved. Core tasks precede auxiliary controls. Queue edits
use one-based visible positions and their captured server revision. Permission and
connection failures explain the next useful action, preserve draft inputs, and
never queue stale commands for replay.

Home, the landing view, uses sideways-scrolling shelves of artwork cards and playlist tiles
with Play, Shuffle and Add on every item; it explains each empty or blocked shelf.
The browsing state uses open rows and ample dark space; desktop expansion uses
large artwork on the left and Up Next on the right. Phone expansion uses art,
identity, timeline, transport, volume/filter, and persistent bottom navigation.

Live OAuth and deployment have independent operations evidence. Physical Discord
listening remains a separate device acceptance check, not a layout assertion. Selected-item tokens now bind favorites, history and mix confirmations;
conflicts require fresh snapshot/library reads and deliberate retry.
