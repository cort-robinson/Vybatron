import { test, expect, type Page } from './test';
import { readFileSync } from 'node:fs';
import { mockPortal } from './fixtures';

// Signing in another screen with a code (ADR-0019).
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Sign in another screen' });
const stored = (page: Page) => page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));

async function approvals(page: Page, answer: (code: string) => { status: number; json: object } = () => ({ status: 200, json: { ok: true } })) {
  const sent: { action: string; code: string; csrf: string | null; type: string | null }[] = [];
  await page.route(/\/auth\/device\/(approve|deny)$/, async route => {
    const request = route.request(); const headers = request.headers();
    const code = request.postDataJSON().code;
    sent.push({ action: request.url().split('/').at(-1)!, code, csrf: headers['x-csrf-token'] || null, type: headers['content-type'] || null });
    const reply = answer(code); await route.fulfill({ status: reply.status, json: reply.json });
  });
  return sent;
}

test('a signed-in listener approves the code from a QR link, after a warning', async ({ page }) => {
  await mockPortal(page); const sent = await approvals(page);
  await page.goto('/link?code=bcdf-ghjk');
  await expect(dialog(page)).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(dialog(page).getByText('Sign in the screen showing this code as Alex?')).toBeVisible();
  await expect(dialog(page).getByText(/Only approve a code shown on a screen in front of you\./)).toBeVisible();
  await expect(dialog(page).getByRole('textbox', { name: 'Code' })).toHaveValue('BCDF-GHJK');
  await page.waitForTimeout(200);
  expect(sent).toEqual([]);
  await dialog(page).getByRole('button', { name: 'Approve' }).click();
  await expect(dialog(page).getByRole('status')).toHaveText('The screen showing BCDF-GHJK is signing in as Alex. It continues on its own in a few seconds.');
  expect(sent).toEqual([{ action: 'approve', code: 'BCDF-GHJK', csrf: 'local-test-csrf', type: 'application/json' }]);
  await dialog(page).getByRole('button', { name: 'Done' }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await stored(page)).not.toContain('BCDF');
});

test('a typed code is normalized, an incomplete or refused one says so, and Deny turns it down', async ({ page }) => {
  await mockPortal(page);
  const sent = await approvals(page, code => code === 'MNPQ-RSTV' ? { status: 200, json: { ok: true } }
    : { status: 400, json: { error: { code: 'invalid_code', message: 'That code isn’t valid or has expired. Check the code on the screen and try again.' } } });
  await page.goto('/link');
  const field = dialog(page).getByRole('textbox', { name: 'Code' });
  await expect(field).toBeFocused(); await expect(field).toHaveValue('');
  await field.fill('bcd');
  await dialog(page).getByRole('button', { name: 'Approve' }).click();
  await expect(dialog(page).getByRole('alert')).toHaveText('Enter the 8-letter code shown on the screen.');
  expect(sent).toEqual([]);
  await field.fill('bcdf ghjk');
  await expect(field).toHaveValue('BCDF-GHJK');
  await field.press('Enter');
  await expect(dialog(page).getByRole('alert')).toHaveText('That code isn’t valid or has expired. Check the code on the screen and try again.');
  await field.fill('mnpqrstv');
  await dialog(page).getByRole('button', { name: 'Deny' }).click();
  await expect(dialog(page).getByRole('status')).toHaveText('The screen showing MNPQ-RSTV won’t be signed in.');
  expect(sent.map(({ action, code }) => [action, code])).toEqual([['approve', 'BCDF-GHJK'], ['deny', 'MNPQ-RSTV']]);
});

test('a signed-out /link keeps its code through Discord sign-in', async ({ page }) => {
  const fixture = await mockPortal(page, { signedOut: true }); await approvals(page);
  await page.route('**/auth/discord', route => { fixture.signIn(); return route.fulfill({ status: 302, headers: { Location: '/' } }); });
  await page.goto('/link?code=BCDF-GHJK');
  await expect(page.getByText('Sign in with Discord to approve the code shown on your other screen.')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  expect(await stored(page)).not.toContain('BCDF');
  await page.getByRole('link', { name: /Continue with Discord/ }).click();
  await expect(dialog(page).getByRole('textbox', { name: 'Code' })).toHaveValue('BCDF-GHJK');
  expect(await stored(page)).not.toContain('BCDF');
});

async function codeSignIn(page: Page, polls: string[]) {
  const starts: { origin: string | null; type: string | null; body: string | null }[] = []; let polled = 0;
  await page.route('**/auth/device/start', async route => {
    const headers = route.request().headers();
    starts.push({ origin: headers.origin || null, type: headers['content-type'] || null, body: route.request().postData() });
    await route.fulfill({ json: { userCode: starts.length === 1 ? 'BCDF-GHJK' : 'MNPQ-RSTV', verificationUri: 'https://portal.example.test/link', expiresIn: 600, interval: 1 } });
  });
  return { starts, polled: () => polled, route: (onApproved: () => void) => page.route('**/auth/device/poll', async route => {
    const status = polls[Math.min(polled++, polls.length - 1)];
    if (status === 'approved') onApproved();
    await route.fulfill({ json: { status } });
  }) };
}

test('signing in with a code shows the code, the address and a QR code, then signs in once approved', async ({ page }) => {
  const fixture = await mockPortal(page, { signedOut: true });
  const flow = await codeSignIn(page, ['pending', 'approved']); await flow.route(() => fixture.signIn());
  await page.goto('/');
  await expect(page.getByRole('link', { name: /Continue with Discord/ })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with a code' }).click();
  await expect(page.getByText('BCDF-GHJK', { exact: true })).toBeVisible();
  await expect(page.getByText('portal.example.test/link', { exact: true })).toBeVisible();
  const qr = page.getByRole('img', { name: 'QR code for portal.example.test/link with this code' });
  await expect(qr).toBeVisible();
  expect(await qr.evaluate(svg => svg.tagName.toLowerCase())).toBe('svg');
  expect((await qr.locator('path').getAttribute('d'))!.length).toBeGreaterThan(1000);
  await expect(page.getByText('Or scan the QR code. Waiting for approval…')).toBeVisible();
  expect(flow.starts).toEqual([{ origin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), type: 'application/json', body: '{}' }]);
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled({ timeout: 10_000 });
  expect(flow.polled()).toBe(2);
});

test('an expired or turned-down code offers a new one, and Discord sign-in stays a tap away', async ({ page }) => {
  await mockPortal(page, { signedOut: true });
  const flow = await codeSignIn(page, ['denied']); await flow.route(() => undefined);
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with a code' }).click();
  await expect(page.getByRole('alert')).toHaveText('That code was turned down. Get a new code to try again.', { timeout: 10_000 });
  await page.unroute('**/auth/device/poll');
  await page.route('**/auth/device/poll', route => route.fulfill({ json: { status: 'expired' } }));
  await page.getByRole('button', { name: 'Get a new code' }).click();
  await expect(page.getByText('MNPQ-RSTV', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('That code expired. Get a new code to try again.', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Sign in with Discord instead' }).click();
  await expect(page.getByRole('link', { name: /Continue with Discord/ })).toBeVisible();
});

// In the app on a TV (ADR-0019), the signed-out screen leads with the code, sized for the couch.
test('on a TV, signing in starts with a code readable from across the room, and Discord is a step away', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.addInitScript(() => {
    const listeners: ((event: { data: string }) => void)[] = [];
    (window as unknown as { vybatronNative: unknown }).vybatronNative = {
      addEventListener: (_type: string, listener: (event: { data: string }) => void) => listeners.push(listener),
      postMessage(data: string) {
        const request = JSON.parse(data);
        const reply = request.type === 'app.info' ? { id: request.id, ok: true, result: { platform: 'android', version: '0.4.0', build: 4, features: ['player.shared'], form: 'tv' } }
          : { id: request.id, ok: false, error: 'unavailable' };
        setTimeout(() => { for (const listener of listeners) listener({ data: JSON.stringify(reply) }); }, 0);
      },
    };
  });
  await mockPortal(page, { signedOut: true });
  const flow = await codeSignIn(page, ['pending']); await flow.route(() => undefined);
  await page.goto('/');
  const code = page.getByText('BCDF-GHJK', { exact: true });
  await expect(code).toBeVisible();
  await expect(page.getByText('portal.example.test/link', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Continue with Discord/ })).toHaveCount(0);
  expect(flow.starts).toHaveLength(1);
  // Large enough to read from a couch, and all of it on the screen.
  const qr = page.getByRole('img', { name: 'QR code for portal.example.test/link with this code' });
  const box = (await qr.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(240);
  expect(box.y + box.height).toBeLessThanOrEqual(540);
  expect(parseFloat(await code.evaluate(element => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(56);
  const back = page.getByRole('button', { name: 'Sign in with Discord instead' });
  const backBox = (await back.boundingBox())!;
  expect(backBox.y + backBox.height).toBeLessThanOrEqual(540);
  await back.click();
  await expect(page.getByRole('link', { name: /Continue with Discord/ })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with a code' }).click();
  await expect(page.getByText('MNPQ-RSTV', { exact: true })).toBeVisible();
});

// The QR code is drawn as SVG elements in the page: the production policy allows it as is.
const policy = readFileSync(new URL('../../server/src/security.js', import.meta.url), 'utf8').match(/'Content-Security-Policy', "([^"]+)"/)![1];
test('the code and QR code show under the production CSP without a violation', async ({ page }) => {
  await mockPortal(page, { signedOut: true });
  const flow = await codeSignIn(page, ['pending']); await flow.route(() => undefined);
  await page.addInitScript(() => {
    const record = window as unknown as { violations: string[] }; record.violations = [];
    document.addEventListener('securitypolicyviolation', event => record.violations.push(`${event.effectiveDirective} ${event.blockedURI}`));
  });
  await page.route('**/*', async route => {
    if (route.request().resourceType() !== 'document') { await route.fallback(); return; }
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with a code' }).click();
  await expect(page.getByRole('img', { name: /^QR code for/ })).toBeVisible();
  const violations = await page.evaluate(() => (window as unknown as { violations: string[] }).violations);
  expect(violations).toEqual([]);
});
