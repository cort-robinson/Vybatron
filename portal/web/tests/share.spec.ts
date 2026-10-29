import { test, expect, type Page } from './test';
import { mockPortal } from './fixtures';

// What the YouTube Music app sends: a sentence with the link inside `text`.
const LINK = 'https://music.youtube.com/watch?v=dX3k_QDnzHE&si=share-token';
const shareUrl = (params: Record<string, string>) => `/share?${new URLSearchParams(params)}`;
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Add shared link' });
// Nothing about the share may stay behind in this browser's storage.
const stored = (page: Page) => page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));

test('a shared link opens a confirmation, leaves the address bar, and queues only after Add to queue', async ({ page }) => {
  const fixture = await mockPortal(page);
  await page.goto(shareUrl({ title: 'Midnight City', text: `Listen to this: ${LINK}.` }));
  await expect(dialog(page).getByText(LINK, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(dialog(page).getByRole('status')).toHaveText('Adds to the queue playing in General.');
  await page.waitForTimeout(200);
  expect(fixture.commands).toEqual([]);
  await dialog(page).getByRole('button', { name: 'Add to queue' }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(fixture.commands).toEqual([{ command: 'play', options: { query: LINK } }]);
  await expect(page.getByRole('status').filter({ hasText: 'Your listening space is updated.' })).toBeVisible();
  expect(await stored(page)).not.toContain('dX3k_QDnzHE');
});

test('cancel discards the shared link without queueing it', async ({ page }) => {
  const fixture = await mockPortal(page);
  await page.goto(shareUrl({ url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc' }));
  await expect(dialog(page).getByText('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await expect(dialog(page)).toHaveCount(0);
  expect(fixture.commands).toEqual([]);
});

test('a share without a supported HTTPS link says so and queues nothing', async ({ page }) => {
  const fixture = await mockPortal(page);
  await page.goto(shareUrl({ text: 'http://www.youtube.com/watch?v=dX3k_QDnzHE https://example.com/song https://youtube.com.evil.test/watch' }));
  await expect(dialog(page).getByText('That share has no YouTube, YouTube Music, Spotify or SoundCloud link.')).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Add to queue' })).toHaveCount(0);
  await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(fixture.commands).toEqual([]);
});

test('a signed-out share survives Discord sign-in and still needs a confirm tap', async ({ page }) => {
  const fixture = await mockPortal(page, { signedOut: true });
  // The real callback signs the device in and redirects to /, dropping every query.
  await page.route('**/auth/discord', route => { fixture.signIn(); return route.fulfill({ status: 302, headers: { Location: '/' } }); });
  const link = 'https://on.soundcloud.com/AbCdEf123';
  await page.goto(shareUrl({ text: `${link} via SoundCloud` }));
  await expect(page.getByText('Sign in with Discord to add the link you shared.')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  // Held only for the sign-in round trip, never before it.
  expect(await stored(page)).not.toContain('AbCdEf123');
  await page.getByRole('link', { name: /Continue with Discord/ }).click();
  await expect(dialog(page).getByText(link, { exact: true })).toBeVisible();
  expect(await stored(page)).not.toContain('AbCdEf123');
  expect(fixture.commands).toEqual([]);
  await dialog(page).getByRole('button', { name: 'Add to queue' }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(fixture.commands).toEqual([{ command: 'play', options: { query: link } }]);
});

test('with several servers the listener chooses one, and the link goes to that server', async ({ page }) => {
  const fixture = await mockPortal(page);
  const other = structuredClone(fixture.state.snapshot);
  other.guild = { ...other.guild, id: 'other', name: 'Late Night Club' }; other.revision = 'other-revision';
  Object.assign(other.session, { status: 'idle', current: null, queue: [], listeners: [], voiceChannel: null, viewerVoice: { id: 'lounge', name: 'Lounge' } });
  fixture.state.bootstrap.guilds.push(other.guild);
  const sent: unknown[] = [];
  await page.route('**/api/guilds/other', route => route.fulfill({ json: other }));
  await page.route('**/api/guilds/other/commands', route => { sent.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true, message: 'Added to the queue.', snapshot: { ...other, revision: 'other-revision-2' } } }); });
  await page.goto(shareUrl({ text: `https://youtu.be/dX3k_QDnzHE?si=x` }));
  const server = dialog(page).getByRole('combobox', { name: 'Server' });
  await expect(server).toHaveValue('');
  await expect(dialog(page).getByRole('status')).toHaveText('Choose the server whose queue gets this link.');
  await expect(dialog(page).getByRole('button', { name: 'Add to queue' })).toBeDisabled();
  await server.selectOption('other');
  await expect(dialog(page).getByRole('status')).toHaveText('Nothing is playing in Late Night Club right now. Vybatron joins Lounge to play it.');
  await dialog(page).getByRole('button', { name: 'Add to queue' }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(sent).toEqual([{ command: 'play', options: { query: 'https://youtu.be/dX3k_QDnzHE?si=x' } }]);
  expect(fixture.commands).toEqual([]);
  await expect(page.getByRole('combobox', { name: 'Server', exact: true })).toHaveValue('other');
});

test('being in voice in one of several servers preselects it', async ({ page }) => {
  const fixture = await mockPortal(page);
  fixture.state.bootstrap.guilds.push({ id: 'other', name: 'Late Night Club', iconUrl: null, admin: false });
  fixture.state.bootstrap.voiceGuildId = 'testing';
  await page.goto(shareUrl({ text: LINK }));
  await expect(dialog(page).getByRole('combobox', { name: 'Server' })).toHaveValue('testing');
  await expect(dialog(page).getByRole('button', { name: 'Add to queue' })).toBeEnabled();
});

test('outside voice the share explains it plays on this device', async ({ page }) => {
  const fixture = await mockPortal(page);
  fixture.state.snapshot.session.viewerVoice = null;
  await page.goto(shareUrl({ text: LINK }));
  await expect(dialog(page).getByRole('status')).toHaveText('You’re not in a voice channel in Bot Testing, so this plays on this device.');
  await expect(dialog(page).getByRole('button', { name: 'Add to queue' })).toBeEnabled();
});

test('when adding is blocked the share shows why and cannot be confirmed', async ({ page }) => {
  await mockPortal(page, { outsideVoice: true });
  await page.goto(shareUrl({ text: LINK }));
  await expect(dialog(page).getByText('Join General to add music or use playback controls.')).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Add to queue' })).toBeDisabled();
});

for (const skin of ['overdrive', 'fantastic', 'haunted', 'classic']) {
  test(`the share confirmation fits a phone in the ${skin} look`, async ({ page }, info) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.addInitScript(value => localStorage.setItem('vybertron.skin', value), skin);
    await mockPortal(page);
    await page.goto(shareUrl({ text: `https://music.youtube.com/playlist?list=${'OLAK5uy_'.padEnd(41, 'x')}&si=${'y'.repeat(16)}` }));
    await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
    const box = await dialog(page).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    await expect(dialog(page).getByRole('button', { name: 'Add to queue' })).toBeInViewport();
    expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`share-${skin}.png`) });
  });
}
