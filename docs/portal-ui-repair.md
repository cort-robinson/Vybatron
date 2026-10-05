# Portal UI repair

This pass addresses the October 5 audit while preserving the approved Aurora
Queue and Luminous Sleeve design, music feature coverage, and server authority.

| Repair | Resulting behavior |
| --- | --- |
| Harden | Search activates deliberately, dismisses reliably and retains the query; shared popovers manage focus and dismissal. The expanded player keeps an active main landmark. |
| Adapt | Phone identity, Pause, Skip and Expand have separate touch targets. Expanded artwork uses the height left after controls, including short phones and landscape. |
| Distill | Radio/voting live in the player. Members see personal preferences; admin tools keep their original rights. Less common forms are explicitly Advanced controls. |
| Clarify | The guild card shows the voice destination and bot state. Permission explanations remain visible in the expanded sleeve. |
| Typeset | Primary track text is 16px, secondary/status text is 14px. Long sleeve titles wrap across two lines. |
| Optimize | Favorites, history and mixes are searchable; queue/library pages bound mounted rows and preserve source indexes/tokens. Inactive panes retain drafts without mounting heavy lists. |
| Layout | Artwork, identity and controls have distinct regions; opaque reading and fixed chrome prevent aurora or underlying text competing with controls. |
| Animate | Decorative motion remains optional and settles on pause/recovery/hidden tabs. Reduced motion retains static pending feedback, labels and busy state. |
| Polish | Semantic chrome/text/effect tokens replace repeated color values, with the approved palette and one Phosphor icon family retained. |

The ambient background and three responsive fallback cover variants total
309,686 bytes, replacing 4,054,126 bytes of public PNGs. Original hashes and
reproduction steps are in `portal/web/public/assets/PROVENANCE.md`. Production
tracks continue using their source artwork.

The compiled production bundle was inspected in one combined render pass and
one confirmation at desktop 1488x1056, phone 390x844, short phone 320x568,
landscape 844x390, and intermediate 1024x768/1280x800 sizes. The eight
queue/player captures had no horizontal overflow, browser exceptions or
WCAG A/AA scan violations. Root inspected the captures directly against the
approved references. The shared preview reported an unavailable desktop host;
headless Chromium supplied this evidence. Android SDK tools and iOS simulation
were unavailable, so this is browser viewport evidence.

Integration review findings were closed with retained advanced-form state,
readable compact queue columns, result retirement after authoritative access
loss, corrected pagination encoding, and assertions for the new title markup.
Desktop navigation/account controls also remain reachable below the expanded
player and in shorter windows. Tests verify original selected-item tokens,
absolute list positions, permission loss and deliberate conflict retries.

Local test tracks are explicit fixtures, never a production demo mode. Browser viewport
checks establish layout and interaction behavior; they do not establish audible
Discord delivery on a physical Windows desktop or phone.

The complete local browser run passed 111 of 113 cases. Its two failures were
an outdated search-result selector and a Chromium resource-loading failure
(`ERR_NO_BUFFER_SPACE`) before the interaction test started. The selector was
corrected. A final focused run passed all 40 affected cases, including that
interaction, responsive player layouts, access-loss handling, and four new
desktop/phone Stop/Clear confirmation cases. Expanded dialogs explicitly restore
pointer input: Cancel/Close makes no mutation, and confirmation submits once with
the original queue revision. The exact release commit must also pass the full
117-case browser suite and other required CI checks before deployment.

The first repair CI run passed all 117 UI browser cases, 434 core tests and 74
API/auth tests. A separate compiled-browser integration assertion still expected
the compact empty-state text to be a heading. It now checks the scoped text and
empty-player button, retaining disabled-control assertions after real channel
permission revocation. The complete two-client transient-outage/offline/revocation
scenario passed locally after that correction. The corrected release still
requires its own full CI gate.
