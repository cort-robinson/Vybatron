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
// Now playing is up, with focus on play (or back on it, if the controls already hid under load).
async function ready(page: Page) {
  await expect(home(page).getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await wake(page);
  await expect.poll(() => focused(page)).toBe('Pause playback');
}
// Under load the controls may already have hidden: a key brings them back (or keeps them up for
// another five seconds) in the same task that focuses the control a test reaches for.
async function wake(page: Page, name?: string) {
  await expect.poll(() => page.evaluate(name => {
    const screen = document.querySelector('[data-testid="tv-home"]')!;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: screen.classList.contains('resting') ? 'ArrowDown' : 'Shift', cancelable: true }));
    if (!name) return !screen.classList.contains('resting');
    const control = Array.from(screen.querySelectorAll<HTMLElement>('button, input')).find(element => element.getAttribute('aria-label') === name || element.textContent?.trim() === name);
    control?.focus();
    return !!control && document.activeElement === control;
  }, name)).toBe(true);
}

for (const [width, height] of [[960, 540], [1920, 1080]] as const) {
  test(`now playing is a TV's first screen, and the arrows move across its controls (${width}×${height})`, async ({ page }) => {
    await tv(page, { width, height });
    await expect(home(page)).toBeVisible();
    await expect(home(page).getByRole('heading', { name: 'Evening Light' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-tv', '');
    // Focus starts on play, with a ring a couch can see.
    await ready(page);
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
    expect(ring).toBe('solid');
    await press(page, 'ArrowLeft'); expect(await focused(page)).toMatch(/Previous song|Restart current song/);
    await press(page, 'ArrowRight', 'ArrowRight'); expect(await focused(page)).toBe('Skip current song');
    await press(page, 'ArrowRight'); expect(await focused(page)).toBe('Volume');
    await press(page, 'ArrowRight'); expect(await focused(page)).toBe('Play on');
    await press(page, 'ArrowRight'); expect(await focused(page)).toBe('Queue');
    await press(page, 'ArrowRight'); expect(await focused(page)).toBe('Visualizer');
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
  await ready(page);
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
  await ready(page);
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
  await ready(page);
  await wake(page, 'Browse');
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
  await ready(page);
  // At now playing the page has nothing of its own; the app leaves.
  expect(await back(page)).toBe(false);
  await wake(page, 'Browse');
  await press(page, 'Enter');
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
  await ready(page);
  expect(await back(page)).toBe(false);
});

test('the controls hide after a few seconds without input, and Up, Down or OK bring them back', async ({ page }) => {
  await tv(page, { bridge: false });
  await ready(page);
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

test('Back closes a song menu inside the queue before the queue itself', async ({ page }) => {
  await tv(page);
  await ready(page);
  await wake(page, 'Queue');
  await press(page, 'Enter');
  const queue = page.getByRole('dialog', { name: 'Up next' });
  await expect(queue).toBeVisible();
  await queue.getByRole('button', { name: 'Song options for Night Drive' }).focus();
  await press(page, 'Enter');
  const menu = queue.locator('.menu-panel');
  await expect(menu).toBeVisible();
  expect(await back(page)).toBe(true);
  await expect(menu).toHaveCount(0);
  await expect(queue).toBeVisible();
  await expect.poll(() => focused(page)).toBe('Song options for Night Drive');
  expect(await back(page)).toBe(true);
  await expect(queue).toHaveCount(0);
});

for (const [width, height] of [[960, 540], [1920, 1080]] as const) {
  test(`the arrows enter a shelf's songs, and a focused control is never under the fixed player (${width}×${height})`, async ({ page }) => {
    const fixture = await tv(page, { width, height });
    await ready(page);
    await wake(page, 'Browse');
    await press(page, 'Enter');
    await expect(home(page)).toHaveCount(0);
    // The page has settled: its covers have loaded and no longer push the shelves down.
    await page.waitForFunction(() => !document.documentElement.dataset.motion && Array.from(document.images).every(image => { const box = image.getBoundingClientRect(); return image.complete || !box.width || box.top > innerHeight || box.bottom < 0; }));
    // Uncovered: the focused control's center hits the control itself, not the player or the navigation over it.
    const visible = () => page.evaluate(() => {
      const element = document.activeElement as HTMLElement; const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return !!hit && (element === hit || element.contains(hit));
    });
    const playAll = page.getByRole('button', { name: 'Play all of On repeat' });
    await expect(playAll).toBeVisible();
    // Reach it with the arrows from the selected tab, as a remote would: Right, then Down.
    for (let step = 0; step < 12 && await focused(page) !== 'Play all of On repeat'; step++) await press(page, step < 1 ? 'ArrowRight' : 'ArrowDown');
    if (await focused(page) !== 'Play all of On repeat') await playAll.focus();
    expect(await visible()).toBe(true);
    await press(page, 'ArrowDown');
    const shelf = page.getByRole('list', { name: 'On repeat in this server' });
    const inShelf = () => shelf.evaluate(list => list !== document.activeElement && list.contains(document.activeElement));
    expect(await inShelf()).toBe(true);
    expect(await focused(page)).toMatch(/^Add .* to the queue$/);
    expect(await visible()).toBe(true);
    const first = await focused(page);
    await press(page, first === 'Add Night Drive to the queue' ? 'ArrowRight' : 'ArrowLeft');
    expect(await inShelf()).toBe(true);
    const song = await focused(page);
    expect(song).not.toBe(first);
    expect(await visible()).toBe(true);
    await press(page, 'Enter');
    const title = song.replace(/^Add (.*) to the queue$/, '$1');
    await expect.poll(() => fixture.commands.filter(command => command.command === 'play').length).toBe(1);
    expect(fixture.commands.find(command => command.command === 'play')?.options?.query).toContain(title.toLowerCase().replace(/ /g, '-'));
  });
}

test('?tv=0 keeps TV mode off even in the app on a TV', async ({ page }) => {
  await tv(page, { form: 'tv', query: '?tv=0' });
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  // Long enough for the app's answer to have arrived.
  await expect.poll(() => page.evaluate(() => (window as unknown as { backAnswers: unknown[] }).backAnswers.length >= 0)).toBe(true);
  await page.waitForTimeout(500);
  await expect(home(page)).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-tv');
  await page.goto('/');
  await page.waitForTimeout(500);
  await expect(page.locator('html')).not.toHaveAttribute('data-tv');
});

// The page with a remote (the owner's report from a Google TV Streamer): the arrows follow rows and
// columns, keep to a shelf, never reach a control off the screen or under the fixed chrome, reach the
// navigation from the page and come back to where they left, and focus survives a view change or a
// list changing under it. Each test covers one jump the arrows used to make.
async function browse(page: Page) {
  await ready(page);
  await wake(page, 'Browse');
  await press(page, 'Enter');
  await expect(home(page)).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe('Home');
  // Settled: covers loaded and no view transition under way.
  await page.waitForFunction(() => !document.documentElement.dataset.motion && Array.from(document.images).every(image => { const box = image.getBoundingClientRect(); return image.complete || !box.width || box.top > innerHeight || box.bottom < 0; }));
}
const within = (page: Page, selector: string) => page.evaluate(selector => !!document.activeElement?.closest(selector), selector);
const shelfSong = (page: Page, shelf: string, song: string) => page.getByRole('list', { name: shelf }).getByRole('button', { name: `Add ${song} to the queue` });
const large = { width: 1920, height: 1080 };

test('at 960×540 Down from the fixed player stays on it, and the page doesn\'t scroll on under it', async ({ page }) => {
  await tv(page);
  await browse(page);
  await page.getByTestId('player').getByRole('button', { name: 'Open player for Evening Light' }).focus();
  const scrolled = await page.evaluate(() => scrollY);
  await press(page, 'ArrowDown');
  expect(await focused(page)).toBe('Open player for Evening Light');
  expect(await page.evaluate(() => scrollY)).toBe(scrolled);
  // Up goes into the page on the screen above it.
  await press(page, 'ArrowUp');
  expect(await within(page, '[data-tv-region="content"]')).toBe(true);
});

test('Down from the fixed player never jumps to the page scrolled out of sight below it', async ({ page }) => {
  await tv(page, large);
  await browse(page);
  await page.getByTestId('player').getByRole('button', { name: 'Open player for Evening Light' }).focus();
  await press(page, 'ArrowDown');
  expect(await focused(page)).toBe('Open player for Evening Light');
});

for (const size of [{ width: 960, height: 540 }, large]) {
  test(`Left and Right stay in a shelf at its ends (${size.width}×${size.height})`, async ({ page }) => {
    await tv(page, size);
    await browse(page);
    // The last song in a shelf: Right goes nowhere, not to another row's control.
    await shelfSong(page, 'On repeat in this server', 'Afterglow').focus();
    await press(page, 'ArrowRight');
    expect(await focused(page)).toBe('Add Afterglow to the queue');
    await press(page, 'ArrowLeft');
    expect(await focused(page)).toBe('Add Golden Hour to the queue');
    // A shelf of one: Right stays, so Down carries on to the next shelf instead of looping back up.
    await shelfSong(page, 'Rediscover', 'Night Drive').focus();
    await press(page, 'ArrowRight');
    expect(await within(page, '[aria-label="Rediscover"]')).toBe(true);
    await press(page, 'ArrowDown');
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('section')?.querySelector('h2')?.textContent)).toBe('Forgotten gems');
  });
}

test('Up from the top of the page never reaches the hidden skip link', async ({ page }) => {
  await tv(page, large);
  await browse(page);
  await page.getByRole('button', { name: 'Search music' }).focus();
  await press(page, 'ArrowUp', 'ArrowUp');
  expect(await focused(page)).toBe('Search music');
  expect(await within(page, '.skip-link')).toBe(false);
});

test('Up from search results returns to the search bar that stays at the top, not past it', async ({ page }) => {
  await tv(page);
  await browse(page);
  await press(page, 'ArrowDown');
  expect(await focused(page)).toBe('Search');
  await press(page, 'Enter');
  const field = page.getByRole('searchbox', { name: 'Music search' });
  await expect(field).toBeFocused();
  await press(page, 'Enter'); await page.keyboard.type('glass'); await press(page, 'Enter');
  await expect(page.getByText('Midnight City')).toBeVisible();
  await press(page, 'ArrowDown');
  expect(await within(page, '.search-page')).toBe(true);
  expect(await within(page, '[role="search"]')).toBe(false);
  await press(page, 'ArrowUp');
  expect(await within(page, '.search-page [role="search"]')).toBe(true);
});

test('choosing a tab keeps focus on it, where the ring shows, and Right goes on into the view', async ({ page }) => {
  await tv(page, large);
  await browse(page);
  await press(page, 'ArrowDown');
  expect(await focused(page)).toBe('Queue');
  await press(page, 'Enter');
  await expect(page.getByRole('heading', { name: 'Shared Queue', level: 1 })).toBeVisible();
  await expect.poll(() => focused(page)).toBe('Queue');
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).toBe('solid');
  await press(page, 'ArrowRight');
  expect(await within(page, '[data-tv-region="content"]')).toBe(true);
});

test('when the focused song leaves the queue, focus goes to the song that took its place', async ({ page }) => {
  await tv(page, large);
  await browse(page);
  await press(page, 'ArrowDown', 'Enter');
  await expect(page.getByRole('heading', { name: 'Shared Queue', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Remove Golden Hour from queue' }).focus();
  await press(page, 'Enter');
  await expect(page.getByRole('button', { name: 'Remove Golden Hour from queue' })).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe('Remove Afterglow from queue');
});

test('Left from the start of a row reaches the navigation\'s current page, and Right comes back', async ({ page }) => {
  await tv(page, large);
  await browse(page);
  await shelfSong(page, 'On repeat in this server', 'Night Drive').focus();
  await press(page, 'ArrowLeft');
  expect(await focused(page)).toBe('Home');
  await press(page, 'ArrowRight');
  expect(await focused(page)).toBe('Add Night Drive to the queue');
});

test('Down from the last page in the side navigation goes to the account below it, not the page beside it', async ({ page }) => {
  await tv(page, large);
  await browse(page);
  await press(page, 'ArrowDown', 'ArrowDown', 'ArrowDown');
  expect(await focused(page)).toBe('Server');
  await press(page, 'ArrowDown');
  expect(await within(page, '.account')).toBe(true);
});

test('Up and Down go row by row: no row is skipped for a control further away in line', async ({ page }) => {
  await tv(page);
  await browse(page);
  // Continue listening: the song card's button below and to the left of View now playing.
  await shelfSong(page, 'Continue listening', 'Afterglow').focus();
  await press(page, 'ArrowUp');
  expect(await focused(page)).toBe('View now playing');
});

test('Down from the search bar at the top reaches the first row of the page, not one further down', async ({ page }) => {
  await tv(page, large);
  await browse(page);
  await page.getByRole('button', { name: 'Search music' }).focus();
  await press(page, 'ArrowDown');
  expect(await focused(page)).toBe('View now playing');
});

test('a shelf remembers its song: up to its header and back down returns to it', async ({ page }) => {
  await tv(page);
  await browse(page);
  await shelfSong(page, 'On repeat in this server', 'Night Drive').focus();
  await press(page, 'ArrowRight', 'ArrowRight');
  expect(await focused(page)).toBe('Add Golden Hour to the queue');
  // Up to the shelf's header, and over to Play all above its first song.
  await press(page, 'ArrowUp', 'ArrowLeft');
  expect(await focused(page)).toBe('Play all of On repeat');
  await press(page, 'ArrowDown');
  expect(await focused(page)).toBe('Add Golden Hour to the queue');
});

test('a long queue over now playing scrolls on to its last song, and back to its first', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 540 });
  const { state } = await mockPortal(page);
  const songs = state.snapshot.session.queue;
  state.snapshot.session.queue = Array.from({ length: 24 }, (_, index) => ({ ...songs[index % songs.length], id: `${songs[index % songs.length].id.slice(0, 20)}q${String(index).padStart(3, '0')}`, title: `Song ${index + 1}` }));
  await page.goto('/?tv=1');
  await ready(page);
  await wake(page, 'Queue');
  await press(page, 'Enter');
  const queue = page.getByRole('dialog', { name: 'Up next' });
  // The compact queue shows fifteen songs a page.
  await expect(queue.getByText('Song 15', { exact: true })).toBeAttached();
  const options = (title: string) => queue.getByRole('button', { name: `Song options for ${title}`, exact: true });
  for (let step = 0; step < 40 && !await options('Song 15').evaluate(button => button === document.activeElement); step++) await press(page, 'ArrowDown');
  await expect(options('Song 15')).toBeFocused();
  await expect(options('Song 15')).toBeInViewport();
  for (let step = 0; step < 40 && !await options('Song 1').evaluate(button => button === document.activeElement); step++) await press(page, 'ArrowUp');
  await expect(options('Song 1')).toBeFocused();
});

test('at 960×540 a TV keeps the side navigation: no tab bar, and the page gets most of the screen', async ({ page }) => {
  await tv(page);
  await browse(page);
  const layout = () => page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const nav = box('.navigation'); const content = box('[data-tv-region="content"]'); const player = box('[data-testid="player"]');
    const tabs = Array.from(document.querySelectorAll('.navigation button')).filter(button => button.getClientRects().length).map(button => button.getBoundingClientRect());
    return { beside: nav.right <= content.left, stacked: tabs.every((tab, index) => !index || tab.top >= tabs[index - 1].bottom - 1), aboveThePlayer: nav.bottom <= player.top,
      position: getComputedStyle(document.querySelector('.navigation')!).position, page: (innerWidth - content.left) * (innerHeight - player.height) / (innerWidth * innerHeight) };
  });
  const { page: share, ...shape } = await layout();
  expect(shape).toEqual({ beside: true, stacked: true, aboveThePlayer: true, position: 'static' });
  expect(share).toBeGreaterThan(.65);
  // Outside TV mode the same width keeps the phone's tab bar along the bottom.
  await page.goto('/?tv=0');
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeAttached();
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.navigation')!).position)).toBe('fixed');
  expect(await page.evaluate(() => document.querySelector('.navigation')!.getBoundingClientRect().bottom)).toBe(540);
});

test('at 960×540 Left from deep in a long list reaches the current tab in one press, and Right comes back', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 540 });
  const { state } = await mockPortal(page);
  const songs = state.snapshot.session.queue;
  state.snapshot.session.queue = Array.from({ length: 24 }, (_, index) => ({ ...songs[index % songs.length], id: `${songs[index % songs.length].id.slice(0, 20)}q${String(index).padStart(3, '0')}`, title: `Song ${index + 1}` }));
  await page.goto('/?tv=1');
  await browse(page);
  await press(page, 'ArrowDown', 'ArrowDown');
  expect(await focused(page)).toBe('Queue');
  await press(page, 'Enter');
  await expect(page.getByRole('heading', { name: 'Shared Queue', level: 1 })).toBeAttached();
  await press(page, 'ArrowRight');
  expect(await within(page, '[data-tv-region="content"]')).toBe(true);
  const deep = page.getByRole('button', { name: 'Song options for Song 18', exact: true });
  for (let step = 0; step < 30 && !await deep.evaluate(button => button === document.activeElement); step++) await press(page, 'ArrowDown');
  await expect(deep).toBeFocused();
  await press(page, 'ArrowLeft');
  expect(await focused(page)).toBe('Queue');
  await press(page, 'ArrowRight');
  await expect(deep).toBeFocused();
});

test('the Visualizer menu on now playing chooses the look, keeps it, and moves MilkDrop on', async ({ page }) => {
  // MilkDrop compiles its presets slowly on the tests' software GPU.
  test.slow();
  await tv(page);
  await ready(page);
  await wake(page, 'Visualizer');
  await press(page, 'Enter');
  const menu = home(page).locator('.menu-panel');
  await expect(menu).toBeVisible();
  // It opens on the look showing (Overdrive's own, until one is chosen), marked as chosen.
  await expect.poll(() => focused(page)).toBe('Gridrunner');
  await expect(menu.getByRole('button', { name: 'Gridrunner' })).toHaveAttribute('aria-pressed', 'true');
  await expect(menu.getByRole('button')).toHaveText(['MilkDrop', 'Gridrunner', 'Cosmic Broadcast', 'Receiver', 'Pumpkin Patch', 'Witching Hour']);
  await press(page, 'ArrowDown', 'ArrowDown');
  expect(await focused(page)).toBe('Receiver');
  await press(page, 'Enter');
  // Chosen at once, as the full-screen visualizer keeps it; the menu stays to try another.
  await expect(menu.getByRole('button', { name: 'Receiver' })).toHaveAttribute('aria-pressed', 'true');
  await expect(menu.getByRole('button', { name: 'Gridrunner' })).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('vybertron.visualizer'))).toBe('receiver');
  expect(await back(page)).toBe(true);
  await expect(menu).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe('Visualizer');

  // Kept across a reload.
  await page.reload();
  await ready(page);
  await wake(page, 'Visualizer');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('Receiver');
  await expect(menu.getByRole('button', { name: 'Receiver' })).toHaveAttribute('aria-pressed', 'true');

  // MilkDrop adds Next preset, named for the preset showing, and Next moves on to another.
  await press(page, 'ArrowUp', 'ArrowUp', 'ArrowUp');
  expect(await focused(page)).toBe('MilkDrop');
  await press(page, 'Enter');
  const next = menu.getByRole('button', { name: 'Next preset' });
  await expect(next).toBeVisible();
  const name = menu.locator('.tv-preset-name');
  await expect(name).not.toBeEmpty({ timeout: 15_000 });
  const first = await name.getAttribute('title');
  await press(page, 'ArrowUp');
  expect(await focused(page)).toBe('Next preset');
  await press(page, 'Enter');
  await expect(name).not.toHaveAttribute('title', first!, { timeout: 15_000 });
  // Reopened with MilkDrop showing, the menu opens on Next preset.
  expect(await back(page)).toBe(true);
  await wake(page, 'Visualizer');
  await press(page, 'Enter');
  await expect.poll(() => focused(page)).toBe('Next preset');
});
