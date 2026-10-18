import { test as base } from '@playwright/test';

export { expect, type Locator, type Page } from '@playwright/test';

// Behavior specs run on the CSS scenery. Under CI's software GPU the WebGL room competes with the
// page for CPU and stretches gestures and timers; scene-gl.spec opts in ('gl') to cover the canvas.
export const cssScene = () => { if (!localStorage.getItem('vybertron.scene')) localStorage.setItem('vybertron.scene', 'css'); };
export const test = base.extend({
  context: async ({ context }, use) => { await context.addInitScript(cssScene); await use(context); },
});
