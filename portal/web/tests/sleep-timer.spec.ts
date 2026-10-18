import { expect, test, type Page } from './test';
import { mockPortal, gotoSession } from './fixtures';

async function openSleep(page: Page) {
  const player = page.getByTestId('player');
  await player.getByRole('button', { name: 'More playback controls' }).click();
  await page.getByRole('button', { name: /^Sleep timer/ }).click();
  return page.getByRole('dialog', { name: 'Sleep timer' });
}

test('the sleep timer sets, shows and turns off from the player', async ({ page }) => {
  const fixture = await mockPortal(page);
  await gotoSession(page);
  const player = page.getByTestId('player');
  await player.getByRole('button', { name: 'Open player', exact: true }).last().click();

  let dialog = await openSleep(page);
  await dialog.getByRole('button', { name: 'In 30 min', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(fixture.commands.at(-1)).toEqual({ command: 'sleep', subcommand: 'in', options: { minutes: 30 } });
  await expect(player.getByText('Sleep timer · Stops in 30 min')).toBeVisible();

  dialog = await openSleep(page);
  const minutes = dialog.getByRole('spinbutton', { name: 'Other time' });
  const set = dialog.getByRole('button', { name: 'Set timer' });
  for (const value of ['0', '721', '1.5']) {
    await minutes.fill(value);
    await expect(set).toBeDisabled();
    await expect(minutes).toHaveAttribute('aria-invalid', 'true');
  }
  await minutes.fill('720');
  await set.click();
  await expect(dialog).toBeHidden();
  expect(fixture.commands.at(-1)).toEqual({ command: 'sleep', subcommand: 'in', options: { minutes: 720 } });
  await expect(player.getByText('Sleep timer · Stops in 12 hr')).toBeVisible();

  dialog = await openSleep(page);
  await dialog.getByRole('button', { name: 'When this song ends' }).click();
  expect(fixture.commands.at(-1)).toEqual({ command: 'sleep', subcommand: 'after-track' });
  await expect(player.getByText('Sleep timer · Stops after this song')).toBeVisible();

  dialog = await openSleep(page);
  await expect(dialog.getByRole('button', { name: 'When this song ends' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Turn off timer' }).click();
  expect(fixture.commands.at(-1)).toEqual({ command: 'sleep', subcommand: 'cancel' });
  await expect(player.getByText(/Sleep timer ·/)).toHaveCount(0);
});

test('listeners without playback control cannot set a sleep timer', async ({ page }) => {
  const fixture = await mockPortal(page, { basic: true });
  fixture.state.snapshot.session.sleep = { mode: 'track' };
  await gotoSession(page);
  const player = page.getByTestId('player');
  await player.getByRole('button', { name: 'Open player', exact: true }).last().click();
  // Everyone can see the timer; only controllers can change it.
  await expect(player.getByText('Sleep timer · Stops after this song')).toBeVisible();
  await player.getByRole('button', { name: 'More playback controls' }).click();
  await expect(page.getByRole('button', { name: 'Sleep timer · Stops after this song' })).toBeDisabled();
});
