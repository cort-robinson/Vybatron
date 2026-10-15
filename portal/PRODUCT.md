# Vybatron portal

schema: impeccable-product-v4

## Product purpose

Friends control an existing Vybatron Discord listening session from a browser or
installed PWA. Music stays in Discord. Success is adding a first song, knowing
what comes next, and sharing control without learning a command manual.

## Positioning

A private shared listening space for installed servers. No public bot install,
browser audio, separate decoder, or second music-data writer. The hardened v2
player and its recovery behavior remain authoritative.

## Users and operating context

Members land on Home: the session to continue, what the server has on repeat, personal
mixes generated from their own requests, and favorites to rediscover. They browse their
private global favorites and server mixes outside voice;
adding music and controlling playback follow fresh Discord visibility, same-voice,
and DJ checks. Guild managers configure listening defaults and read diagnostics.
Verified maintainers use trusted server-granted access. Desktop and portrait phone
use are equally complete, commonly while Discord is already open in a dim room.

## Evidence on hand

- Binding behavior and DTOs: `../docs/portal-plan.md`, `../docs/portal-contract.md`.
- Approved visuals: `../docs/portal-references/queue.png`, `player.png`, `phone.png`.
- Root-supplied runtime aurora and cover rasters in `web/public/assets/`.
- Browser-test fixtures are explicit synthetic local evidence, never public content.

## Product principles

- One current identity, one timeline, and one control cluster per player state.
- The persistent player expands into the sleeve view and survives navigation.
- Useful permission, offline, empty, loading, conflict, and recovery states.
- Reconnect fetches fresh state. Never replay mutations; a 409 requires a deliberate retry.
- Show real source artwork and Discord avatars. Fallback artwork is honest and bundled.
- Artwork-derived light and the spectrum are decorative and generated, never measured audio;
  they are optional and quiet while browsing. Respect reduced
  motion, paused/recovering states, hidden tabs, and hidden views.
- Private API/auth/music data never enter persistent browser caches. Local storage holds
  only ambient preference and last guild selection; authority always comes from the server.

## Brand and accessibility

Confident, musical, welcoming. The portal is an album-reactive receiver: the current
cover relights the room and drives the single accent, a decorative VFD-style spectrum
shows the session is alive, and Archivo's wide cuts give names and numerals a faceplate
voice. Rose favorites and amber pause/recovery stay fixed regardless of artwork.
Familiar icons, legible type, visible focus, semantic forms, keyboard queue moves, and
touch controls matter more than novelty.

## Delivery boundary

The web task owns `web/**`, this product record, design record, surface brief, and
design QA. The root owns runtime aurora/fallback assets, integration, CI, infrastructure,
OAuth provisioning, and live listening validation. No web-task commits or deployment.
