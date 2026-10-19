import { test, expect, type Page } from './test';
import { mockPortal } from './fixtures';

// The play button's skin ring (::before/::after outset) must not crowd the controls beside it, and
// the room it takes must not push the transport into the footer's other controls.
const spacing = (page: Page) => page.locator('.transport .play-button').evaluateAll(buttons => buttons.filter(button => button.getBoundingClientRect().width > 0).map(button => {
  const outset = Math.max(0, ...['::before', '::after'].map(pseudo => { const style = getComputedStyle(button, pseudo); return style.content === 'none' ? 0 : -parseFloat(style.left) || 0; }));
  const box = button.getBoundingClientRect(); const ring = { left: box.left - outset, right: box.right + outset, top: box.top - outset, bottom: box.bottom + outset };
  const transport = button.closest('.transport')!, footer = button.closest('.player-footer')!;
  const shown = (node: Element) => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden'; };
  const controls = Array.from(transport.children).filter(node => node !== button && shown(node)).map(node => node.getBoundingClientRect());
  const clearance = Math.min(...controls.map(rect => rect.right <= box.left ? ring.left - rect.right : rect.left - ring.right));
  const edges = [ring, ...controls];
  // Only controls on the play button's row: the ring may reach up toward the timeline by design, and the seek bar sits just below.
  const others = Array.from(footer.querySelectorAll('button, select, input, a')).filter(node => !transport.contains(node) && shown(node)).map(node => node.getBoundingClientRect()).filter(rect => box.top < (rect.top + rect.bottom) / 2 && (rect.top + rect.bottom) / 2 < box.bottom);
  const overlaps = edges.flatMap(a => others.filter(b => a.left < b.right && b.left < a.right).map(b => `${Math.round(b.left)}-${Math.round(b.right)}`));
  return { clearance, overlaps };
}));
const settled = async (page: Page) => {
  await expect.poll(() => spacing(page).then(all => Math.min(...all.map(entry => entry.clearance)))).toBeGreaterThanOrEqual(8);
  await expect.poll(() => spacing(page).then(all => all.flatMap(entry => entry.overlaps))).toEqual([]);
};

const viewports = [{ name: 'desktop', width: 1488, height: 1056 }, { name: 'tablet', width: 700, height: 852 }, { name: 'phone', width: 393, height: 852 }, { name: 'small phone', width: 320, height: 640 }];
for (const skin of ['overdrive', 'fantastic', 'classic'])
  for (const { name, width, height } of viewports)
    test(`${skin} ${name}: the play ring keeps clear of the neighbouring controls`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(look => localStorage.setItem('vybertron.skin', look), skin);
      await mockPortal(page); await page.goto('/');
      await expect(page.getByRole('button', { name: 'Pause playback' }).first()).toBeEnabled();
      await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
      await settled(page);
      await page.getByRole('button', { name: 'Open player', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Evening Light' })).toBeVisible();
      await settled(page);
    });
