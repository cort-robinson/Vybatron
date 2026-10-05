---
primary: src/App.tsx
related:
  - src/components/Player.tsx
  - src/components/Queue.tsx
  - src/components/Library.tsx
  - src/components/Server.tsx
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

The browsing state uses open rows and ample dark space; desktop expansion uses
large artwork on the left and Up Next on the right. Phone expansion uses art,
identity, timeline, transport, volume/filter, and persistent bottom navigation.

Unresolved beyond web scope: live OAuth, deployment and physical Discord playback
gates. Selected-item tokens now bind favorites, history and mix confirmations;
conflicts require fresh snapshot/library reads and deliberate retry.
