import { test, expect } from './test';
import { mockPortal } from './fixtures';

// The open player fits phone screens without scrolling, a two-line title and a skin's caption plate
// included, and each skin's frame sits evenly around the cover. 450×700 hides the spectrum strip.
const title = "JoJo's Bizarre Adventure | Bloody Stream Full Opening Theme";
const frames: Record<string, string> = { fantastic: '.ff-tv', haunted: '.hh-frame', overdrive: '.od-cover-plate' };
for (const skin of ['fantastic', 'haunted', 'overdrive', 'classic'])
  for (const [width, height] of [[499, 729], [450, 700], [416, 608]])
    test(`${skin} ${width}×${height}: the open player fits and the cover sits in its frame`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(look => localStorage.setItem('vybertron.skin', look), skin);
      await mockPortal(page, { title }); await page.goto('/');
      await page.getByRole('button', { name: 'Open player', exact: true }).click();
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Show lyrics' })).toBeInViewport({ ratio: 1 });
      await expect.poll(() => page.locator('.sleeve-content').evaluate(node => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(0);
      const frame = frames[skin];
      if (frame) await expect.poll(() => page.locator('.sleeve-artwork').evaluate((sleeve, selector) => {
        const cover = sleeve.querySelector('.artwork')!.getBoundingClientRect(), around = sleeve.querySelector(selector)!.getBoundingClientRect();
        return Math.round(Math.abs((cover.top - around.top) - (around.bottom - cover.bottom)) + Math.abs((cover.left - around.left) - (around.right - cover.right)));
      }, frame)).toBeLessThanOrEqual(1);
    });
