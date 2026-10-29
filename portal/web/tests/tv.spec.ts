import { test, expect, type Page } from './test';
import { mockPortal } from './fixtures';

// The portal with a remote (ADR-0019): on a TV, now playing is the first screen, the arrow keys move
// focus within the topmost layer, sliders and fields take the arrows only while being edited, and
// the app's Back asks the page first. `?tv=1` turns TV mode on in a browser; the app's bridge is a
// stand-in that sends Back the way MainActivity does and records the page's answers.
type Answer = { back: number; handled: boolean };
async function tv(page: Page, { width = 960, height = 540, bridge = true, form, query = '?tv=1' }: { width?: number; height?: number; bridge?: boolean; form?: 'tv' | 'phone'; query?: string } = {}) {
  await page.setViewportSize({ width, height });
  const fixture = await mockPortal(page);
  if (bridge) await page.addInitScript(appForm => {
    const listeners: ((event: { data: string }) => void)[] = [];
    const answers: Answer[] = []; let next = 1;
    const send = (message: unknown) => setTimeout(() => { for (const listener of listeners) listener({ data: JSON.stringify(message) }); }, 0);
    const state = { revision: 0, current: null, queue: [], history: [], status: 'idle', positionMs: 0, at: Date.now(), waiting: false, durationMs: 0, volume: 100, repeat: 'off' };
    (window as unknown as { appBack: () => number; backAnswers: Answer[] }).backAnswers = answers;
    // Like MainActivity on Back: an event the page answers with the request `app.back`.
    (window as unknown as { appBack: () => number }).appBack = () => { const back = next++; send({ event: 'app.back', back }); return back; };
    (window as unknown as { vybatronNative: unknown }).vybatronNative = {
      addEventListener: (_type: string, listener: (event: { data: string }) => void) => listeners.push(listener),
      postMessage(data: string) {
        const request = JSON.parse(data);
        if (request.type === 'app.info') send({ id: request.id, ok: true, result: { platform: 'android', version: '0.4.0', build: 4, features: ['player.shared'], ...(appForm && { form: appForm }) } });
        else if (request.type === 'app.back') { answers.push({ back: request.back, handled: request.handled }); send({ id: request.id, ok: true, result: {} }); }
        else send({ id: request.id, ok: true, result: { ...state, link: { linked: true, generation: null } } });
      },
    };
  }, form ?? null);
  await page.goto(`/${query}`);
  return fixture;
}
// Presses the app's Back and returns whether the page handled it.
async function back(page: Page) {
  const id = await page.evaluate(() => (window as unknown as { appBack: () => number }).appBack());
  await expect.poll(() => page.evaluate(id => (window as unknown as { backAnswers: Answer[] }).backAnswers.find(answer => answer.back === id), id)).toBeTruthy();
  return page.evaluate(id => (window as unknown as { backAnswers: Answer[] }).backAnswers.find(answer => answer.back === id)!.handled, id);
}
const focused = (page: Page) => page.evaluate(() => { const element = document.activeElement as HTMLElement | null; return element?.getAttribute('aria-label') || element?.textContent?.trim() || element?.tagName || ''; });
const home = (page: Page) => page.getByTestId('tv-home');
async function press(page: Page, ...keys: string[]) { for (const key of keys) await page.keyboard.press(key); }

for (const [width, height] of [[960, 540], [1920, 1080]] as const) {
  test(`now playing is a TV's first screen, and the arrows move across its controls (${width}×${height})`, async ({ page }) => {
    await tv(page, { width, height });
    await expect(home(page)).toBeVisible();
    await expect(home(page).getByRole('heading', { name: 'Evening Light' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-tv', '');
    // Focus starts on play, with a ring a couch can see.
    await expect.poll(() => focused(page)).toBe('Pause playback');
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
    expect(ring).toBe('solid');
    await press(page, 'ArrowLeft'); expect(await focused(page)).toMatch(/Previous song|Restart current song/);
    await press(page, 'ArrowRight', 'ArrowRight'); expect(await focused(page)).toBe('Skip current song');
    await press(page, 'ArrowRight'); expect(await focused(page)).toBe('Volume');
    await press(page, 'ArrowRight'); expect(await focused(page)).toBe('Play on');
    await press(page, 'ArrowRight'); expect(await focused(page)).toBe('Queue');
    await press(page, 'ArrowRight'); expect(await focused(page)).toBe('Browse');
    // Nothing further right: focus stays.
    await press(page, 'ArrowRight'); expect(await focused(page)).toBe('Browse');
    await press(page, 'ArrowUp'); expect(await focused(page)).toBe('Playback position');
    await press(page, 'ArrowDown'); expect(await focused(page)).not.toBe('Playback position');
    // The page behind now playing can't take focus.
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="tv-home"]'))).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`tv-home-${width}.png`) });
  });
}

test('the Play on menu and the queue keep the arrows inside them, and Back closes them', async ({ page }) => {
  await tv(page);
  await expect.poll(() => focused(page)).toBe('Pause playback');
  await press(page, 'ArrowRight', 'ArrowRight', 'ArrowRight');
  expect(await focused(page)).toBe('Play on');
  await press(page, 'Enter');
  const menu = home(page).locator('.menu-panel');
  await expect(menu).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.menu-panel'))).toBe(true);
  const first = await focused(page);
  await press(page, 'ArrowDown');
  const second = await focused(page);
  expect(second).not.toBe(first);
  expect(second).toMatch(/Discord/);
  // At the menu's edge focus stays in the menu, never on the controls behind it.
  await press(page, 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.menu-panel'))).toBe(true);
  await press(page, 'ArrowUp', 'ArrowUp', 'ArrowUp');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.menu-panel'))).toBe(true);
  expect(await back(page)).toBe(true);
  await expect(menu).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe('Play on');

  await press(page, 'ArrowRight', 'Enter');
  const queue = page.getByRole('dialog', { name: 'Up next' });
  await expect(queue).toBeVisible();
  await expect(queue.getByText('Night Drive')).toBeVisible();
  // Into the queue: the arrows reach its rows and stay in the dialog.
  for (let step = 0; step < 4; step++) await press(page, 'ArrowDown');
  expect(await page.evaluate(() => !!document.activeElement?.closest('dialog[open]'))).toBe(true);
  expect(await page.evaluate(() => !!document.activeElement?.closest('.queue, .track-row, li'))).toBe(true);
  for (let step = 0; step < 12; step++) await press(page, 'ArrowUp');
  expect(await page.evaluate(() => !!document.activeElement?.closest('dialog[open]'))).toBe(true);
  expect(await back(page)).toBe(true);
  await expect(queue).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe('Queue');
});

test('the seek and volume sliders take the arrows only while OK has them editing', async ({ page }) => {
  const fixture = await tv(page);
  await expect.poll(() => focused(page)).toBe('Pause playback');
  const seek = page.getByRole('slider', { name: 'Playback position' });
  await press(page, 'ArrowUp');
  expect(await focused(page)).toBe('Playback position');
  const before = Number(await seek.inputValue());
  // Not editing: Right leaves the position alone (and there's nothing to its right).
  await press(page, 'ArrowRight', 'ArrowRight');
  expect(await focused(page)).toBe('Playback position');
  expect(Number(await seek.inputValue())).toBeLessThan(before + 5000);
  expect(fixture.commands.filter(command => command.command === 'seek')).toEqual([]);
  await press(page, 'Enter');
  await expect(seek).toHaveAttribute('data-tv-editing', '');
  // Editing: ten seconds a press, sent as a seek.
  await press(page, 'ArrowRight');
  await expect.poll(() => fixture.commands.filter(command => command.command === 'seek').length).toBe(1);
  const [seekCommand] = fixture.commands.filter(command => command.command === 'seek');
  const target = String(seekCommand.options?.timestamp).split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
  expect(target).toBeGreaterThanOrEqual(Math.floor(before / 1000) + 9);
  // OK stops editing; the arrows move focus again.
  await press(page, 'Enter');
  await expect(seek).not.toHaveAttribute('data-tv-editing', '');
  await press(page, 'ArrowDown');
  expect(await focused(page)).not.toBe('Playback position');

  const volume = page.getByRole('slider', { name: 'Volume' }).filter({ visible: true });
  await volume.focus();
  await press(page, 'ArrowLeft');
  expect(await focused(page)).toBe('Skip current song');
  await press(page, 'ArrowRight');
  expect(await focused(page)).toBe('Volume');
  expect(fixture.commands.filter(command => command.command === 'volume')).toEqual([]);
  await press(page, 'Enter', 'ArrowRight');
  await expect.poll(() => fixture.commands.filter(command => command.command === 'volume').map(command => command.options?.level)).toEqual([80]);
  // Back stops editing before anything else.
  expect(await back(page)).toBe(true);
  await expect(volume).not.toHaveAttribute('data-tv-editing', '');
  await expect(home(page)).toBeVisible();
  await press(page, 'ArrowLeft');
  expect(await focused(page)).toBe('Skip current song');
});

test('the search field brings up the keyboard only when OK starts editing it', async ({ page }) => {
  await tv(page);
  await expect.poll(() => focused(page)).toBe('Pause playback');
  await home(page).getByRole('button', { name: 'Browse' }).focus();
  await press(page, 'Enter');
  await expect(home(page)).toHaveCount(0);
  // At 960 wide Search is a tab of its own.
  await page.getByRole('button', { name: 'Search', exact: true }).focus();
  await press(page, 'Enter');
  const field = page.getByRole('searchbox', { name: 'Music search' });
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('type', 'search');
  // Focused but not editing: no on-screen keyboard, and the arrows leave the field.
  await expect(field).toHaveAttribute('inputmode', 'none');
  await press(page, 'Enter');
  await expect(field).toHaveAttribute('data-tv-editing', '');
  await expect(field).not.toHaveAttribute('inputmode', 'none');
  await page.keyboard.type('glass');
  await expect(field).toHaveValue('glass');
  // Editing: Left moves the caret, not focus.
  await press(page, 'ArrowLeft', 'ArrowLeft');
  await expect(field).toBeFocused();
  expect(await field.evaluate(input => (input as HTMLInputElement).selectionStart)).toBe(3);
  // Back stops editing; then the arrows move focus.
  expect(await back(page)).toBe(true);
  await expect(field).not.toHaveAttribute('data-tv-editing', '');
  await expect(field).toHaveAttribute('inputmode', 'none');
  await press(page, 'ArrowRight');
  await expect(field).not.toBeFocused();
});

test('Back on a TV goes back a view, then to now playing, then leaves the app', async ({ page }) => {
  await tv(page, { width: 1920, height: 1080 });
  await expect.poll(() => focused(page)).toBe('Pause playback');
  // At now playing the page has nothing of its own; the app leaves.
  expect(await back(page)).toBe(false);
  await home(page).getByRole('button', { name: 'Browse' }).click();
  await expect(home(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  await expect.poll(() => focused(page)).toBe('Home');
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shared Queue', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'My Music', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My Music', level: 1 })).toBeVisible();
  // A dialog first.
  await page.getByRole('button', { name: 'Add music' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Add music' })).toBeVisible();
  expect(await back(page)).toBe(true);
  await expect(page.getByRole('dialog', { name: 'Add music' })).toHaveCount(0);
  // Back through the views visited, then to now playing.
  await expect(page.getByRole('heading', { name: 'My Music', level: 1 })).toBeVisible();
  expect(await back(page)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Shared Queue', level: 1 })).toBeVisible();
  expect(await back(page)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  expect(await back(page)).toBe(true);
  await expect(home(page)).toBeVisible();
  await expect.poll(() => focused(page)).toBe('Pause playback');
  expect(await back(page)).toBe(false);
});

test('the controls hide after a few seconds without input, and Up, Down or OK bring them back', async ({ page }) => {
  await tv(page, { bridge: false });
  await expect.poll(() => focused(page)).toBe('Pause playback');
  await press(page, 'ArrowRight');
  expect(await focused(page)).toBe('Skip current song');
  await expect(home(page)).toHaveClass(/resting/, { timeout: 8000 });
  // Hidden controls hold no focus: it waits on the screen.
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('tv-home');
  await expect(page.locator('.tv-controls')).toHaveAttribute('inert', '');
  // The first press only brings them back, to the control focus left.
  await press(page, 'ArrowDown');
  await expect(home(page)).not.toHaveClass(/resting/);
  expect(await focused(page)).toBe('Skip current song');
  // Input keeps them up.
  for (let step = 0; step < 4; step++) { await page.waitForTimeout(1500); await press(page, step % 2 ? 'ArrowLeft' : 'ArrowRight'); }
  await expect(home(page)).not.toHaveClass(/resting/);
  await expect(home(page)).toHaveClass(/resting/, { timeout: 8000 });
  await press(page, 'Enter');
  await expect(home(page)).not.toHaveClass(/resting/);
  // OK that brought the controls back pressed nothing.
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeVisible();
});

test('the app on a TV turns TV mode on by itself, and the flag lasts for the tab', async ({ page }) => {
  await tv(page, { form: 'tv', query: '' });
  await expect(home(page)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-tv', '');
  await page.goto('/?tv=1');
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-tv', '');
});

test('outside TV mode nothing changes, and Back in the app closes only menus and dialogs', async ({ page }) => {
  await tv(page, { width: 1600, height: 900, form: 'phone', query: '' });
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  await expect(home(page)).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-tv');
  // The arrows don't move focus between controls.
  await page.getByRole('button', { name: 'Queue', exact: true }).focus();
  await press(page, 'ArrowDown');
  expect(await focused(page)).toBe('Queue');
  // A slider's arrows still change it at once.
  const volume = page.getByTestId('player').getByRole('slider', { name: 'Volume' });
  await volume.focus();
  await press(page, 'ArrowRight');
  await expect(volume).toHaveValue('76');
  await expect(volume).not.toHaveAttribute('data-tv-editing');
  // Back with nothing open is the app's.
  expect(await back(page)).toBe(false);
  await page.getByTestId('player').getByRole('button', { name: 'More playback controls' }).click();
  await expect(page.getByTestId('player').locator('.menu-panel')).toBeVisible();
  expect(await back(page)).toBe(true);
  await expect(page.getByTestId('player').locator('.menu-panel')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add music' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Add music' })).toBeVisible();
  expect(await back(page)).toBe(true);
  await expect(page.getByRole('dialog', { name: 'Add music' })).toHaveCount(0);
  expect(await back(page)).toBe(false);
  // `?tv=0` turns a tab's flag off.
  await page.goto('/?tv=1');
  await expect(page.locator('html')).toHaveAttribute('data-tv', '');
  await page.goto('/?tv=0');
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-tv');
});
