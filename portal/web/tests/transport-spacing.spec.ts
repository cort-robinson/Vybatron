import { test, expect, type Page } from './test';
import { mockPortal } from './fixtures';

// The play button's skin ring (::before/::after outset) must not crowd the controls beside it.
const clearance = (page: Page) => page.locator('.transport .play-button').evaluateAll(buttons => buttons.filter(button => button.getBoundingClientRect().width > 0).map(button => {
  const outset = Math.max(0, ...['::before', '::after'].map(pseudo => { const style = getComputedStyle(button, pseudo); return style.content === 'none' ? 0 : -parseFloat(style.left) || 0; }));
  const ring = button.getBoundingClientRect(); const left = ring.left - outset, right = ring.right + outset;
  const neighbours = [button.previousElementSibling, button.nextElementSibling].map(node => node?.getBoundingClientRect()).filter(box => box && box.width > 0) as DOMRect[];
  return Math.min(...neighbours.map(box => box.right <= ring.left ? left - box.right : box.left - right));
}));

for (const skin of ['overdrive', 'fantastic', 'classic'])
  for (const { name, width, height } of [{ name: 'desktop', width: 1488, height: 1056 }, { name: 'phone', width: 393, height: 852 }])
    test(`${skin} ${name}: the play ring keeps clear of the neighbouring controls`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(look => localStorage.setItem('vybertron.skin', look), skin);
      await mockPortal(page); await page.goto('/');
      await expect(page.getByRole('button', { name: 'Pause playback' }).first()).toBeEnabled();
      await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
      await expect.poll(() => clearance(page).then(gaps => Math.min(...gaps))).toBeGreaterThanOrEqual(8);
      await page.getByRole('button', { name: 'Open player', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Evening Light' })).toBeVisible();
      await expect.poll(() => clearance(page).then(gaps => Math.min(...gaps))).toBeGreaterThanOrEqual(8);
    });
