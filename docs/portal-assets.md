# Portal visual assets

The portal follows the user-selected Aurora Queue and Luminous Sleeve views in
`portal-references/queue.png` and `portal-references/player.png`, with the approved
phone adaptation in `portal-references/phone.png`. These references are design
targets, not production session content.

Two original raster assets were generated with the built-in image generation
tool for this portal on 2026-10-04:

| Runtime asset | Purpose | SHA-256 |
| --- | --- | --- |
| `portal/web/public/assets/aurora.png` | Subtle decorative cyan and magenta light on dark navy | `8aa6dd06d15df49f0fad25b3e4cecd29ac11fa47156f80f0efc3797c88939d8e` |
| `portal/web/public/assets/fallback-cover.png` | Artwork when a source has no usable cover | `8d79eec200c5a2f65c96f29736d9d1cedc16c0811a4571c5437c351b654878c6` |

Production tracks use their projected public source artwork and requesters use
Discord avatars. Fictional songs, covers and listeners in the browser tests are
explicit fixtures; they are not bundled as production sessions. The ambient
effect is decorative, not an audio spectrum or a claim of beat synchronization.
Motion respects the user's setting, reduced-motion preference, playback state
and hidden tabs. The portal neither decodes nor plays music in the browser.

The client uses self-hosted Manrope from its pinned font package and Phosphor
icons from the pinned React package. Their package licenses remain in the
dependency distributions. Asset changes should be compared against the selected
references and verified on both desktop and phone layouts.
