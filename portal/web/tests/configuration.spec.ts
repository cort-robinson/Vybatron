import { test, expect, type Page } from './test';
import type { Configuration } from '../src/types';
import { startHttpFixture } from './http-fixture';
import { openServer, openSettings } from './fixtures';

type Fixture = Awaited<ReturnType<typeof startHttpFixture>>;
const channelId = '323456789012345678';
const roleId = '423456789012345678';

async function connected(page: Page, server: Fixture) {
  await page.goto(server.origin);
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await expect.poll(() => server.streams.size).toBe(1);
}
async function settings(page: Page) {
  await openServer(page);
  await expect(page.getByRole('heading', { name: 'Your listening space' })).toBeVisible();
}
async function loaded(page: Page) {
  await expect(page.getByRole('combobox', { name: 'Music text channel', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh options', exact: true })).toBeEnabled();
}

test('configuration: one catalog GET per Settings visit despite fresh SSE frames', async ({ page }) => {
  const server = await startHttpFixture({ pollMs: 250 });
  try {
    await connected(page, server);
    expect(server.configurationReads).toHaveLength(0);
    expect(server.state.snapshot.channels.some(channel => channel.id === 'lounge')).toBe(false);
    await settings(page); await loaded(page);
    await expect(page.locator('#music-channel option')).toHaveText(['Choose a music channel', '# General', '# music-lounge']);
    await expect(page.locator('#dj-role option')).toHaveText(['Everyone in voice', 'DJs']);
    await page.waitForTimeout(800); // Several live frames arrive while Settings is open.
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    expect(server.configurationReads).toEqual([{ guildId: 'testing', method: 'GET' }]);
    await page.screenshot({ path: test.info().outputPath('configuration-desktop.png'), fullPage: true });

    await page.getByRole('tab', { name: 'Advanced controls' }).click();
    server.state.snapshot.revision = 'configuration-hidden-tab-frame'; server.broadcast();
    await expect(page.getByRole('heading', { name: 'Advanced music controls' })).toBeVisible();
    expect(server.configurationReads).toHaveLength(1);
    await page.getByRole('tab', { name: 'Settings', exact: true }).click(); await loaded(page);
    expect(server.configurationReads).toHaveLength(2);
    await page.getByRole('button', { name: 'Queue', exact: true }).click();
    await page.getByRole('button', { name: 'My Music', exact: true }).click();
    server.state.snapshot.revision = 'configuration-hidden-server-frame'; server.broadcast();
    expect(server.configurationReads).toHaveLength(2);
    await settings(page); await loaded(page);
    expect(server.configurationReads).toHaveLength(3);
    await page.getByRole('button', { name: 'Refresh options', exact: true }).click();
    await expect.poll(() => server.configurationReads.length).toBe(4);
    await loaded(page);
    expect(server.commands).toHaveLength(0);
  } finally { await page.close(); await server.close(); }
});

test('configuration: phone drafts survive transient discovery failures, native reconnect and manual retry', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const server = await startHttpFixture();
  try {
    server.failNextConfigurationReads(2);
    await connected(page, server); await settings(page);
    await expect(page.getByRole('alert')).toContainText('Channel and role options are temporarily unavailable.');
    const channel = page.locator('#music-channel'); const role = page.locator('#dj-role'); const volume = page.getByLabel('Default volume', { exact: true });
    await channel.fill(channelId); await role.fill(roleId); await volume.fill('46');
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    server.state.snapshot.settings!.volume = 91;
    server.state.snapshot.settings!.musicTextChannelId = 'text'; server.state.snapshot.settings!.djRoleId = 'dj';
    server.state.snapshot.revision = 'configuration-remote-defaults'; server.broadcast();
    await expect(volume).toHaveValue('46'); await expect(channel).toHaveValue(channelId); await expect(role).toHaveValue(roleId);

    server.disconnectAndHold();
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeDisabled();
    await expect(volume).toBeDisabled(); await expect(channel).toHaveValue(channelId);
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect.poll(() => server.capturedSnapshots.size).toBe(1);
    server.releaseSnapshotReads();
    await expect(volume).toBeEnabled();
    await expect(channel).toHaveValue(channelId); await expect(role).toHaveValue(roleId); await expect(volume).toHaveValue('46');
    expect(server.configurationReads).toHaveLength(1);
    await page.screenshot({ path: test.info().outputPath('configuration-phone-error.png'), fullPage: true });

    await page.getByRole('button', { name: 'Try again', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => server.configurationReads.length).toBe(2);
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeEnabled();
    await expect(channel).toHaveValue(channelId); await expect(role).toHaveValue(roleId); await expect(volume).toHaveValue('46');
    await page.getByRole('button', { name: 'Try again', exact: true }).click(); await loaded(page);
    await expect(channel).toHaveValue(channelId); await expect(role).toHaveValue(roleId); await expect(volume).toHaveValue('46');
    await expect(channel.locator('option:checked')).toHaveText(`Channel ID: ${channelId}`);
    await expect(role.locator('option:checked')).toHaveText(`Role ID: ${roleId}`);
    expect(server.configurationReads).toHaveLength(3);
    expect(server.commands).toHaveLength(0);
  } finally { await page.close(); await server.close(); }
});

// Settings treats 401, 403 and 404 as one denial.
for (const status of [403]) {
  test(`configuration: a hard ${status} clears catalog choices and cannot fall back to snapshot roles`, async ({ page }) => {
    const server = await startHttpFixture();
    try {
      await connected(page, server); await settings(page); await loaded(page);
      await page.locator('#music-channel').selectOption('lounge'); await page.locator('#dj-role').selectOption('dj');
      server.failNextConfigurationReads(1, status);
      await page.getByRole('button', { name: 'Refresh options', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Channel and role options are temporarily unavailable.');
      await expect(page.locator('#music-channel option')).toHaveCount(0); await expect(page.locator('#dj-role option')).toHaveCount(0);
      await expect(page.locator('#music-channel')).toHaveValue('lounge'); await expect(page.locator('#dj-role')).toHaveValue('dj');
      server.state.snapshot.revision = `configuration-after-${status}`; server.broadcast();
      await expect(page.getByLabel('Default volume', { exact: true })).toBeEnabled();
      await expect(page.locator('#music-channel option')).toHaveCount(0); await expect(page.locator('#dj-role option')).toHaveCount(0);
      expect(server.state.snapshot.roles).toHaveLength(1);
      expect(server.configurationReads).toHaveLength(2); expect(server.commands).toHaveLength(0);
    } finally { await page.close(); await server.close(); }
  });
}

test('configuration: admin revocation clears options and aborts an in-flight refresh before restoration', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server); await settings(page); await loaded(page);
    const defaults = server.state.snapshot.settings;
    server.holdConfigurationReads();
    await page.getByRole('button', { name: 'Refresh options', exact: true }).click();
    await expect.poll(() => server.heldConfigurations.size).toBe(1);
    server.state.snapshot.guild.admin = false; server.state.snapshot.settings = null;
    server.state.snapshot.revision = 'configuration-admin-revoked'; server.broadcast();
    await expect(page.getByText('Server settings need Manage Server permission.')).toBeVisible();
    await expect(page.locator('#music-channel')).toHaveCount(0); await expect(page.locator('#dj-role')).toHaveCount(0);
    await expect.poll(() => server.configurationAborts).toEqual(['testing']);
    server.releaseConfigurationReads();
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    expect(server.configurationReads).toHaveLength(2);
    server.state.configuration.channels = [{ id: 'restored-channel', name: 'restored-music', type: 'text' }];
    server.state.configuration.roles = [{ id: 'restored-role', name: 'Restored DJs' }];
    server.state.snapshot.guild.admin = true; server.state.snapshot.settings = defaults;
    server.state.snapshot.revision = 'configuration-admin-restored'; server.broadcast(); await loaded(page);
    await expect(page.locator('#music-channel option')).toContainText(['Choose a music channel', 'Channel ID: text', '# restored-music']);
    await expect(page.locator('#dj-role option')).toHaveText(['Everyone in voice', 'Restored DJs']);
    expect(server.configurationReads).toHaveLength(3); expect(server.commands).toHaveLength(0);
  } finally { await page.close(); await server.close(); }
});

test('configuration: a delayed old-guild response and a foreign DTO cannot replace current-guild options', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    const other = structuredClone(server.state.snapshot);
    other.guild = { id: 'other', name: 'Another listening space', iconUrl: null, admin: true }; other.revision = 'other-guild-revision';
    other.settings = { volume: 37, fairQueue: false, autoplay: 'off', musicTextChannelId: 'other-text', djRoleId: null };
    other.channels = [{ id: 'other-text', name: 'other-current', type: 'text' }]; other.roles = [{ id: 'other-dj', name: 'Other snapshot DJs' }];
    const configuration: Configuration = { guildId: 'other', channels: [{ id: 'other-text', name: 'other-music', type: 'text' }], roles: [{ id: 'other-dj', name: 'Other DJs' }] };
    server.addGuild(other, configuration); server.holdConfigurationReads();
    await connected(page, server); await settings(page);
    await expect.poll(() => server.heldConfigurations.size).toBe(1);
    await page.getByRole('combobox', { name: 'Server', exact: true }).selectOption('other'); await loaded(page);
    await expect(page.locator('#music-channel option')).toHaveText(['Choose a music channel', '# other-music']);
    await expect(page.locator('#dj-role option')).toHaveText(['Everyone in voice', 'Other DJs']);
    await expect(page.getByLabel('Default volume', { exact: true })).toHaveValue('37');
    await expect.poll(() => server.configurationAborts).toEqual(['testing']);
    server.releaseConfigurationReads(); server.broadcast(other);
    expect(server.configurationReads).toEqual([{ guildId: 'testing', method: 'GET' }, { guildId: 'other', method: 'GET' }]);

    server.replaceNextConfiguration(server.state.configuration);
    await page.getByRole('button', { name: 'Refresh options', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Channel and role options are unavailable.');
    await expect(page.locator('#music-channel option')).toHaveText(['Choose a music channel', '# other-music']);
    await expect(page.locator('#dj-role option')).toHaveText(['Everyone in voice', 'Other DJs']);
    expect(server.configurationReads).toHaveLength(3); expect(server.commands).toHaveLength(0);
  } finally { await page.close(); await server.close(); }
});

test('configuration: discovery recovery cannot authorize offline writes or replay settings and playback lanes', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    server.failNextConfigurationReads(1);
    await connected(page, server); await settings(page);
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeEnabled();
    const volume = page.getByLabel('Default volume', { exact: true }); const save = volume.locator('..').getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeEnabled(); await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    await volume.fill('53'); server.holdCommandReplies(); await save.click();
    await expect.poll(() => server.heldCommands.size).toBe(1);
    expect(server.commands).toEqual([{ command: 'settings', subcommand: 'volume', options: { value: 53 } }]);
    server.disconnectAndHold();
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeDisabled();
    await page.getByRole('button', { name: 'Try again', exact: true }).click(); await loaded(page);
    await expect(save).toBeDisabled(); await expect(page.getByRole('button', { name: 'Pause playback' })).toBeDisabled();
    await expect(volume).toHaveValue('53'); expect(server.commands).toHaveLength(1);
    server.releaseCommandReplies();
    await expect.poll(() => server.capturedSnapshots.size).toBe(1);
    server.releaseSnapshotReads();
    await expect(save).toBeEnabled(); await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    await expect(volume).toHaveValue('53');
    await page.getByRole('button', { name: 'Refresh options', exact: true }).click();
    await expect.poll(() => server.configurationReads.length).toBe(3); await loaded(page);
    expect(server.commands).toHaveLength(1);
    await page.getByRole('button', { name: 'Pause playback' }).click();
    await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
    // Pause is idempotent set-state: it carries no revision fence.
    await expect.poll(() => server.commands).toEqual([{ command: 'settings', subcommand: 'volume', options: { value: 53 } }, { command: 'pause' }]);
  } finally { await page.close(); await server.close(); }
});

test('configuration: basic members never discover catalogs while personal settings remain available', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    server.state.snapshot.guild.admin = false; server.state.snapshot.settings = null;
    server.state.snapshot.channels = []; server.state.snapshot.roles = [];
    await connected(page, server); await openServer(page);
    await expect(page.getByText('Server settings need Manage Server permission.')).toBeVisible();
    await openSettings(page);
    await page.getByLabel('Ambient motion', { exact: true }).selectOption('off'); server.broadcast();
    await expect(page.getByLabel('Ambient motion', { exact: true })).toHaveValue('off');
    expect(server.configurationReads).toHaveLength(0); expect(server.commands).toHaveLength(0);
  } finally { await page.close(); await server.close(); }
});
