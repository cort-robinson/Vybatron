# ADR-0014: The portal's MilkDrop visualizer runs Butterchurn with WebAssembly-only equations

- Status: Accepted (chosen by the maintainer, 2026-10-28)
- Date: 2026-10-28
- Builds on: [ADR-0013](0013-visualizer-energy-maps-in-the-bot.md)

## Context

The portal's visualizers are our own shaders, driven by each song's energy map or by motion
generated for it (ADR-0013). The maintainer wanted MilkDrop's presets in their place of Neon,
an homage that only imitated that style of feedback visual. Butterchurn (MIT) is the maintained
WebGL port of MilkDrop, and butterchurn-presets (MIT) carries its preset packs.

MilkDrop presets are programs: each has per-frame and per-vertex equations in MilkDrop's
expression language. Butterchurn 3 can compile them to WebAssembly at load time or convert
them to JavaScript and run them with `new Function`. The portal's CSP allows neither:
`script-src 'self'`.

Butterchurn also expects to analyse live audio through Web Audio, and the browser has none:
Discord plays the song, and routing this device's player through Web Audio stops it in the
background on iOS.

## Decision

- **Butterchurn 3.0.0-beta.5 and butterchurn-presets 3.0.0-beta.4, pinned exactly.** MilkDrop
  takes Neon's place among the presets; a stored choice of Neon becomes MilkDrop.
- **`'wasm-unsafe-eval'` in `script-src`, nothing more.** Butterchurn runs with `onlyUseWASM`,
  so preset equations compile to WebAssembly and its `new Function` path is never taken. The
  converted presets carry only the original equations, none of that JavaScript. `'unsafe-eval'`
  stays out, and a server test asserts it.
- **No AudioContext.** Butterchurn is given none (it needs one only for its analyser nodes and
  sample rate) and is fed time-domain samples each frame, written from the song's energy map or
  generated motion (`portal/web/src/visualizer/waveform.ts`).
- **A curated set, in its own chunk.** About forty presets from the packs, chosen for looking
  good at a small drawing buffer and staying cheap on phone GPUs, are bundled with Butterchurn
  in a chunk loaded only when MilkDrop is chosen. The other presets don't load it.

## Consequences

- Any script on the portal's origin may compile WebAssembly. Scripts still come only from the
  origin itself, and JavaScript eval stays blocked.
- Butterchurn sets a few globals on `window` and `Math` when its chunk loads, and draws through a
  WebGL2 context of its own that it copies to the page's canvas each frame.
- The service worker precaches every built file, so installing the app downloads the MilkDrop
  chunk even for someone who never opens it.
- Butterchurn 3 is a beta. Moving to its release means checking that `onlyUseWASM` and the
  `render({ audioLevels })` input still work as they do here.
