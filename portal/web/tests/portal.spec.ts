import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockPortal, streamAction } from './fixtures';

test('signed-out portal uses Discord OAuth and exposes no demo player', async ({ page }) => {
  await mockPortal(page, { signedOut: true }); await page.goto('/');
  await expect(page.getByRole('link', { name: /Continue with Discord/ })).toHaveAttribute('href', '/auth/discord');
  await expect(page.getByTestId('player')).toHaveCount(0);
  await expect(page.locator('audio, video')).toHaveCount(0);
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 393, height: 852 }]) {
  test(`normal ${viewport.width}x${viewport.height} account sign-out sends no body and leaves playback running`, async ({ page }) => {
    await page.setViewportSize(viewport); const fixture = await mockPortal(page); await page.goto('/');
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    if (viewport.width > 960) {
      await page.getByRole('button', { name: 'Account options' }).click();
      await page.getByRole('button', { name: 'Sign out on this device' }).click();
    } else {
      await page.getByRole('button', { name: 'Server', exact: true }).click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    }
    await expect(page.getByRole('link', { name: /Continue with Discord/ })).toBeVisible();
    await expect(page.getByTestId('player')).toHaveCount(0);
    expect(fixture.logouts).toEqual([{ method: 'POST', body: null, contentType: null, csrfToken: 'local-test-csrf' }]);
    expect(fixture.commands).toHaveLength(0); expect(fixture.state.snapshot.session.status).toBe('playing');
    await page.reload(); await expect(page.getByRole('link', { name: /Continue with Discord/ })).toBeVisible();
  });
}

test('one player transforms, stays across navigation, and sends scoped core commands', async ({ page }) => {
  const fixture = await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Evening Light' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Pause playback' }).click();
  await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  expect(fixture.commands[0]).toEqual({ command: 'pause', expectedRevision: 'revision-1' });
  expect(fixture.commands[0]).not.toHaveProperty('actorId');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Evening Light' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Resume playback', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Playback position' })).toBeEnabled();
  await page.getByRole('slider', { name: 'Playback position' }).focus(); await page.keyboard.press('Home');
  await expect.poll(() => fixture.commands.find(c => c.command === 'seek')?.options?.timestamp).toBe('00:00:00');
  await page.getByRole('button', { name: 'My Music', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Always your favorites' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await page.getByRole('button', { name: 'More playback controls' }).click();
  await page.getByRole('button', { name: 'Artist radio on' }).click();
  await expect.poll(() => fixture.commands.at(-1)?.command).toBe('radio');
  await page.getByRole('button', { name: 'More playback controls' }).click();
  await page.getByRole('button', { name: 'Stop and discard session' }).click();
  await expect(page.getByRole('dialog', { name: 'Stop this listening session?' })).toBeVisible();
  expect(fixture.commands.some(c => c.command === 'stop')).toBe(false);
  await page.getByRole('button', { name: 'Stop and discard', exact: true }).click();
  await expect.poll(() => fixture.commands.at(-1)?.command).toBe('stop');
  expect(fixture.commands.at(-1)).not.toHaveProperty('expectedRevision');
});

test('disconnect preserves search input, gates writes, refreshes before deliberate retry', async ({ page }) => {
  const fixture = await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await page.getByRole('button', { name: 'Add music', exact: true }).first().click();
  await page.getByRole('searchbox', { name: 'Music search' }).fill('my long playlist draft');
  await streamAction(page, 'disconnect');
  await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeDisabled();
  await expect(page.getByRole('searchbox', { name: 'Music search' })).toHaveValue('my long playlist draft');
  expect(fixture.commands).toHaveLength(0);
  fixture.delaySnapshot(450); await streamAction(page, 'reconnect');
  await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeEnabled();
  expect(fixture.commands).toHaveLength(0);
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click();
  await expect.poll(() => fixture.commands.length).toBe(1);
  expect(fixture.commands[0]).toEqual({ command: 'play', options: { query: 'my long playlist draft' } });
});

test('a queue conflict refreshes authoritative order without replaying stale indices', async ({ page }) => {
  const fixture = await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  fixture.conflictNext(); await page.getByRole('button', { name: 'Song options for Slow Motion' }).click();
  await page.getByRole('button', { name: 'Move up', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Review the refreshed state');
  expect(fixture.commands).toHaveLength(1);
  expect(fixture.commands[0]).toEqual({ command: 'move', options: { from: 2, to: 1 }, expectedRevision: 'revision-1' });
  await expect(page.locator('.track-list').first().locator('.track-text strong').first()).toHaveText('Afterglow');
  await page.getByRole('button', { name: 'Song options for Slow Motion' }).click(); await page.getByRole('button', { name: 'Move up', exact: true }).click();
  await expect.poll(() => fixture.commands.length).toBe(2);
  expect(fixture.commands[1]).toEqual({ command: 'move', options: { from: 3, to: 2 }, expectedRevision: 'revision-2' });
});

test('queued favorites work outside voice and confirmed clearing preserves the paused current song', async ({ page }) => {
  const fixture = await mockPortal(page, { outsideVoice: true }); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Save Slow Motion to favorites' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeDisabled();
  await page.getByRole('button', { name: 'Save Slow Motion to favorites' }).click();
  await expect(page.getByRole('button', { name: 'Remove Slow Motion from favorites' })).toBeVisible();
  expect(fixture.commands[0]).toEqual({ command: 'favorite', subcommand: 'add', options: { position: 2 }, expectedRevision: 'revision-1' });
  fixture.state.snapshot.session.canControl = true; fixture.state.snapshot.session.reason = null;
  await streamAction(page, 'reconnect', fixture.state.snapshot);
  await page.getByRole('button', { name: 'Pause playback' }).click();
  await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  await page.getByRole('button', { name: 'More playback controls' }).click();
  await page.getByRole('button', { name: 'Clear upcoming queue' }).click();
  expect(fixture.commands.some(c => c.command === 'clear')).toBe(false);
  await page.getByRole('button', { name: 'Clear queue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Make room for a good vibe' })).toBeVisible();
  expect(fixture.commands.at(-1)).toEqual({ command: 'clear', expectedRevision: 'revision-3' });
  await expect(page.getByRole('heading', { name: 'Evening Light' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveAttribute('aria-valuetext', '1:47 of 3:57');
});

test('uncertain command completion fetches fresh state and never retries the mutation', async ({ page }) => {
  const fixture = await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  const reads = fixture.requests.filter(path => path === '/api/guilds/testing').length;
  fixture.uncertainNext();
  await page.getByRole('button', { name: 'Add music', exact: true }).first().click();
  await page.getByRole('searchbox', { name: 'Music search' }).fill('https://example.com/public-playlist');
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('this action may have completed');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await expect(page.getByRole('searchbox', { name: 'Music search' })).toHaveValue('https://example.com/public-playlist');
  expect(fixture.requests.filter(path => path === '/api/guilds/testing').length).toBeGreaterThan(reads);
  expect(fixture.commands).toHaveLength(1);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.locator('.track-list').first().locator('.track-text strong')).toHaveCount(5);
  expect(fixture.commands).toHaveLength(1);
});

test('a public import may exceed a short read deadline without aborting or replaying', async ({ page }) => {
  test.setTimeout(40_000);
  const fixture = await mockPortal(page); fixture.delayCommand(22_000); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await page.getByRole('button', { name: 'Add music', exact: true }).first().click();
  await page.getByRole('searchbox', { name: 'Music search' }).fill('https://example.com/long-public-playlist');
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeDisabled();
  await expect(page.getByRole('status').last()).toContainText('Your listening space is updated.', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeEnabled();
  expect(fixture.commands).toHaveLength(1);
});

test('a GET started before going offline cannot enable writes after transport loss', async ({ page }) => {
  const fixture = await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  const reads = fixture.requests.filter(path => path === '/api/guilds/testing').length;
  fixture.delaySnapshot(500);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => fixture.requests.filter(path => path === '/api/guilds/testing').length).toBeGreaterThan(reads);
  // A refresh now retires its old stream before reading; going offline must
  // still invalidate the GET even when there is no active EventSource to fail.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.waitForTimeout(600);
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeDisabled();
  expect(fixture.commands).toHaveLength(0);
  await streamAction(page, 'reconnect');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  expect(fixture.commands).toHaveLength(0);
});

test('voice and DJ restrictions preserve library and voting access without admin data', async ({ page }) => {
  const fixture = await mockPortal(page, { basic: true }); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeDisabled();
  await page.getByRole('button', { name: 'Vote to skip', exact: true }).click();
  await expect.poll(() => fixture.commands[0]?.command).toBe('voteskip');
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Diagnostics', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Music text channel')).toHaveCount(0);
  expect(fixture.requests.some(r => r.endsWith('/activity') || r.endsWith('/diagnostics'))).toBe(false);
  await page.getByRole('button', { name: 'My Music', exact: true }).click();
  await page.getByRole('button', { name: 'Remove favorite Night Drive' }).click();
  await expect.poll(() => fixture.commands.at(-1)?.subcommand).toBe('remove');
});

test('play-next and history replay require DJ control and send the fresh revision from every entry point', async ({ page }) => {
  const fixture = await mockPortal(page, { basic: true }); await page.goto('/');
  await page.getByRole('button', { name: 'Add music', exact: true }).first().click();
  await page.getByRole('searchbox', { name: 'Music search' }).fill('Midnight City');
  await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Play next', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'My Music', exact: true }).click(); await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByRole('button', { name: 'Replay Afterglow' })).toBeDisabled();
  await page.getByRole('button', { name: 'Server', exact: true }).click(); await page.getByRole('tab', { name: 'More controls' }).click();
  for (const name of ['playnext', 'replay']) {
    await page.getByLabel('Command', { exact: true }).selectOption(name);
    await expect(page.getByRole('button', { name: 'Run command' })).toBeDisabled();
  }
  expect(fixture.commands).toHaveLength(0);
  fixture.state.snapshot.session.canControl = true; fixture.state.snapshot.session.reason = null; fixture.state.snapshot.revision = 'revision-dj-ready';
  await streamAction(page, 'reconnect', fixture.state.snapshot);
  await page.getByRole('button', { name: 'Add music', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Play next', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Play next', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play next', exact: true })).toBeEnabled();
  expect(fixture.commands[0]).toEqual({ command: 'playnext', options: { query: 'Midnight City' }, expectedRevision: 'revision-dj-ready' });
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'My Music', exact: true }).click(); await page.getByRole('tab', { name: 'History' }).click();
  await page.getByRole('button', { name: 'Replay Afterglow' }).click();
  await expect(page.getByRole('button', { name: 'Replay Afterglow' })).toBeEnabled();
  expect(fixture.commands[1]).toEqual({ command: 'replay', options: { index: 1 }, expectedHistoryId: 'history-1', expectedRevision: 'revision-2' });
  await page.getByRole('button', { name: 'Server', exact: true }).click(); await page.getByRole('tab', { name: 'More controls' }).click();
  await page.getByLabel('Command', { exact: true }).selectOption('playnext'); await page.getByLabel('query').fill('Night Drive');
  await page.getByRole('button', { name: 'Run command' }).click(); await expect(page.getByRole('button', { name: 'Run command' })).toBeEnabled();
  expect(fixture.commands[2]).toEqual({ command: 'playnext', options: { query: 'Night Drive' }, expectedRevision: 'revision-3' });
  await page.getByLabel('Command', { exact: true }).selectOption('replay'); await page.getByLabel('index').fill('1');
  await page.getByRole('button', { name: 'Run command' }).click(); await expect(page.getByRole('button', { name: 'Run command' })).toBeEnabled();
  expect(fixture.commands[3]).toEqual({ command: 'replay', options: { index: 1 }, expectedHistoryId: 'history-1', expectedRevision: 'revision-4' });
  fixture.state.snapshot.session.canControl = false; await streamAction(page, 'reconnect', fixture.state.snapshot);
  await expect(page.getByRole('button', { name: 'Run command' })).toBeDisabled(); expect(fixture.commands).toHaveLength(4);
});

test('visible current favorites and mix saves remain available outside voice, including schema forms', async ({ page }) => {
  const fixture = await mockPortal(page, { outsideVoice: true }); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Remove current song from favorites' })).toBeEnabled();
  await page.getByRole('button', { name: 'Remove current song from favorites' }).click();
  await expect(page.getByRole('button', { name: 'Save current song to favorites' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save current song to favorites' }).click();
  await expect(page.getByRole('button', { name: 'Remove current song from favorites' })).toBeVisible();
  expect(fixture.commands[1]).toEqual({ command: 'favorite', subcommand: 'add', expectedRevision: 'revision-2' });
  await page.getByRole('button', { name: 'My Music', exact: true }).click(); await page.getByRole('tab', { name: 'Shared mixes' }).click();
  await page.getByPlaceholder('Late night drive').fill('Visible session'); await page.getByRole('button', { name: 'Save mix', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Visible session', exact: true })).toBeVisible();
  expect(fixture.commands[2]).toEqual({ command: 'mix', subcommand: 'save', options: { name: 'Visible session', replace: false }, expectedRevision: 'revision-3' });
  await expect(page.getByRole('button', { name: 'Queue mix', exact: true }).first()).toBeDisabled();
  await page.getByRole('tab', { name: 'History' }).click(); await expect(page.getByRole('button', { name: 'Replay Afterglow' })).toBeDisabled();
  await page.getByRole('button', { name: 'Server', exact: true }).click(); await page.getByRole('tab', { name: 'More controls' }).click();
  await page.getByLabel('Command', { exact: true }).selectOption('mix'); await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption('save');
  await page.getByLabel('name').fill('From schema'); await page.getByRole('button', { name: 'Run command' }).click();
  await expect(page.getByRole('button', { name: 'Run command' })).toBeEnabled();
  expect(fixture.commands[3]).toEqual({ command: 'mix', subcommand: 'save', options: { name: 'From schema' }, expectedRevision: 'revision-4' });
  await page.getByLabel('Command', { exact: true }).selectOption('favorite'); await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption('add');
  await page.getByRole('spinbutton', { name: 'position', exact: true }).fill('2'); await page.getByRole('button', { name: 'Run command' }).click();
  await expect(page.getByRole('button', { name: 'Run command' })).toBeEnabled();
  expect(fixture.commands[4]).toEqual({ command: 'favorite', subcommand: 'add', options: { position: 2 }, expectedRevision: 'revision-5' });
  await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption('clear'); await page.getByLabel('confirm').selectOption('true');
  await page.getByRole('button', { name: 'Run command' }).click(); await expect(page.getByRole('button', { name: 'Run command' })).toBeEnabled();
  expect(fixture.commands[5]).toMatchObject({ command: 'favorite', subcommand: 'clear', options: { confirm: true } });
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeDisabled();
});

test('maintainer settings accept known Discord IDs without revealing a private catalog', async ({ page }) => {
  const fixture = await mockPortal(page, { maintainerOutsideGuild: true }); await page.goto('/');
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  const channel = page.getByLabel('Music text channel ID', { exact: true }); const role = page.getByLabel('DJ role ID', { exact: true });
  const channelSave = channel.locator('..').getByRole('button', { name: 'Save', exact: true });
  const roleSave = role.locator('..').getByRole('button', { name: 'Save', exact: true });
  await expect(channel).toHaveValue('123456789012345678'); await expect(role).toHaveValue('223456789012345678');
  await expect(page.getByRole('heading', { name: 'Evening Light' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume playback' })).toBeDisabled();
  await channel.fill('<#123456789012345678>'); await expect(channelSave).toBeDisabled();
  await role.fill('1e18'); await expect(roleSave).toBeDisabled(); expect(fixture.commands).toHaveLength(0);
  await channel.fill('323456789012345678'); await channelSave.click(); await expect(channelSave).toBeEnabled();
  expect(fixture.commands[0]).toEqual({ command: 'settings', subcommand: 'musicchannel', options: { channel: '323456789012345678' } });
  await role.fill('423456789012345678'); await roleSave.click(); await expect(roleSave).toBeEnabled();
  expect(fixture.commands[1]).toEqual({ command: 'settings', subcommand: 'djrole', options: { role: '423456789012345678' } });
  await role.fill(''); await roleSave.click(); await expect(roleSave).toBeEnabled();
  expect(fixture.commands[2]).toEqual({ command: 'settings', subcommand: 'djrole', options: {} });
  await page.getByRole('tab', { name: 'More controls' }).click(); await page.getByLabel('Command', { exact: true }).selectOption('settings');
  await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption('musicchannel'); await page.getByLabel('channel ID', { exact: true }).fill('5e17');
  await page.getByRole('button', { name: 'Run command' }).click(); expect(fixture.commands).toHaveLength(3);
  await page.getByLabel('channel ID', { exact: true }).fill('523456789012345678'); await page.getByRole('button', { name: 'Run command' }).click();
  await expect(page.getByRole('button', { name: 'Run command' })).toBeEnabled();
  expect(fixture.commands[3]).toMatchObject({ command: 'settings', subcommand: 'musicchannel', options: { channel: '523456789012345678' } });
  await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption('djrole'); await page.getByLabel('role ID', { exact: true }).fill('623456789012345678');
  await page.getByRole('button', { name: 'Run command' }).click(); await expect(page.getByRole('button', { name: 'Run command' })).toBeEnabled();
  expect(fixture.commands[4]).toMatchObject({ command: 'settings', subcommand: 'djrole', options: { role: '623456789012345678' } });
  await page.getByRole('tab', { name: 'Diagnostics', exact: true }).click(); await expect(page.getByText('Discord connection', { exact: true })).toBeVisible();
  expect(fixture.state.snapshot.channels).toEqual([]); expect(fixture.state.snapshot.roles).toEqual([]);
});

test('library, shared mixes, history, settings, schema forms, activity and diagnostics use real endpoint shapes', async ({ page }) => {
  const fixture = await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await page.getByRole('button', { name: 'My Music', exact: true }).click();
  await page.getByRole('button', { name: 'Queue favorite Night Drive' }).click();
  await expect.poll(() => fixture.commands.at(-1)?.subcommand).toBe('play');
  await page.getByRole('tab', { name: 'Shared mixes' }).click(); await page.getByPlaceholder('Late night drive').fill('After hours');
  await page.getByRole('button', { name: 'Save mix', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'After hours', exact: true })).toBeVisible();
  expect(fixture.commands.at(-1)).toMatchObject({ command: 'mix', subcommand: 'save', options: { name: 'After hours', replace: false } });
  await page.getByRole('tab', { name: 'History' }).click(); await page.getByRole('button', { name: 'Replay Afterglow' }).click();
  await expect.poll(() => fixture.commands.at(-1)?.command).toBe('replay'); expect(fixture.commands.at(-1)?.options).toEqual({ index: 1 });
  await page.getByRole('button', { name: 'Server', exact: true }).click(); await page.getByLabel('Music text channel').selectOption('lounge');
  await page.getByLabel('Music text channel').locator('..').getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => fixture.commands.at(-1)?.subcommand).toBe('musicchannel');
  await page.getByRole('tab', { name: 'More controls' }).click(); await page.getByLabel('Command', { exact: true }).selectOption('seek');
  await page.getByLabel('timestamp').fill('01:30'); await page.getByRole('button', { name: 'Run command' }).click();
  await expect.poll(() => fixture.commands.at(-1)?.options?.timestamp).toBe('01:30');
  await page.getByRole('tab', { name: 'Activity', exact: true }).click(); await expect(page.getByText('Night Drive joined the shared queue.')).toBeVisible();
  await page.getByRole('tab', { name: 'Diagnostics', exact: true }).click(); await expect(page.getByText('Discord connection', { exact: true })).toBeVisible();
  expect(fixture.requests).toContain('/api/guilds/testing/diagnostics');
});

test('saved-session recovery keeps checkpoint position and pause state', async ({ page }) => {
  const fixture = await mockPortal(page, { saved: true }); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Resume session' })).toBeEnabled();
  await page.getByRole('button', { name: 'Resume session' }).click();
  await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  expect(fixture.commands[0]).toEqual({ command: 'session', subcommand: 'resume', expectedRevision: 'revision-1' });
  await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveAttribute('aria-valuetext', '1:47 of 3:57');
});

test('permission loss clears protected tracks and disconnected context', async ({ page }) => {
  const fixture = await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  fixture.denySnapshot(403); await streamAction(page, 'reconnect');
  await expect(page.getByRole('heading', { name: 'Evening Light' })).toHaveCount(0);
  await expect(page.getByText('Night Drive', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume playback' })).toBeDisabled();
});

test('an HTTP-rejected SSE connection verifies session loss and clears the player', async ({ page }) => {
  const fixture = await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  fixture.denySnapshot(401); await streamAction(page, 'disconnect');
  await expect(page.getByRole('link', { name: /Continue with Discord/ })).toBeVisible();
  await expect(page.getByTestId('player')).toHaveCount(0);
  expect(fixture.commands).toHaveLength(0);
});

test('phone player is singular, keyboard-accessible, responsive and reduced-motion safe', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 }); await page.emulateMedia({ reducedMotion: 'reduce' }); await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled(); await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Evening Light' })).toHaveCount(1);
  await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Pause playback' })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const motion = await page.locator('.aurora-field').evaluate(el => getComputedStyle(el).animationName); expect(motion).toBe('none');
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(result.violations).toEqual([]);
});
