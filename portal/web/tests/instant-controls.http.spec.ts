import { expect, test, type Page } from '@playwright/test';
import { gotoSession } from './fixtures';
import type { GuildSnapshot } from '../src/types';
import { startHttpFixture } from './http-fixture';

type Fixture = Awaited<ReturnType<typeof startHttpFixture>>;
test.use({ viewport: { width: 1440, height: 900 } });
const instanceId = '748c50dc-f3f0-4bb5-8b57-692912648dc6';
// Every snapshot the bridge captures gets a newer sequence than earlier ones.
const stamp = (snapshot: GuildSnapshot) => { snapshot.ordering = { instanceId, sequence: (snapshot.ordering?.sequence || 0) + 1 }; };
const player = (page: Page) => page.getByTestId('player');
const play = (page: Page, playing: boolean) => player(page).getByRole('button', { name: playing ? 'Pause playback' : 'Resume playback', exact: true });
const titles = (page: Page) => page.locator('.queue:not(.queue-compact) .track-row strong').allInnerTexts();

async function connected(page: Page, server: Fixture) {
  stamp(server.state.snapshot);
  await gotoSession(page, server.origin);
  await expect(play(page, true)).toBeEnabled();
  await expect.poll(() => server.streams.size).toBe(1);
}
async function songMenu(page: Page, title: string, action: string) {
  await page.locator('.queue:not(.queue-compact)').getByRole('button', { name: `Song options for ${title}` }).click();
  await page.getByRole('button', { name: action }).click();
}

test('Pause and Resume change the player immediately while the bot confirms in the background', async ({ page }) => {
  const server = await startHttpFixture({ orderedCommands: true });
  try {
    await connected(page, server);
    server.holdCommandExecution();
    const clicked = Date.now();
    await play(page, true).click();
    // No round trip: the control flips and stays usable while Discord confirms.
    await expect(play(page, false)).toBeEnabled({ timeout: 250 });
    expect(Date.now() - clicked).toBeLessThan(1000);
    await expect(player(page).getByRole('group', { name: 'Playback controls' })).not.toHaveAttribute('aria-busy', 'true');
    await expect(player(page).getByText('Waiting for confirmation')).toHaveCount(0);
    await expect.poll(() => server.commands.map(command => command.command)).toEqual(['pause']);
    expect(server.commands[0].expectedRevision).toBeUndefined();
    // A slow confirmation is acknowledged quietly instead of locking the player.
    await expect(player(page).getByText('Syncing with Discord…')).toBeVisible();
    server.releaseCommandExecution();
    await expect(player(page).getByText('Syncing with Discord…')).toHaveCount(0);
    await expect(play(page, false)).toBeEnabled();
    await expect(page.locator('.toast.success')).toHaveCount(0);
    await play(page, false).click();
    await expect(play(page, true)).toBeEnabled({ timeout: 250 });
    await expect.poll(() => server.commands.map(command => command.command)).toEqual(['pause', 'resume']);
    await expect(player(page).getByText('Syncing with Discord…')).toHaveCount(0);
  } finally { await server.close(); }
});

test('rapid toggles coalesce into the newest choice without replaying superseded commands', async ({ page }) => {
  const server = await startHttpFixture({ orderedCommands: true });
  try {
    await connected(page, server);
    server.holdCommandExecution();
    await play(page, true).click();
    await play(page, false).click();
    await play(page, true).click();
    await expect(play(page, false)).toBeVisible();
    await expect.poll(() => server.commands.length).toBe(1);
    server.releaseCommandExecution();
    // Resume was replaced by Pause before it left the browser; Pause was already sent.
    await expect(player(page).getByText('Syncing with Discord…')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(server.commands.map(command => command.command)).toEqual(['pause']);
    await expect(play(page, false)).toBeVisible();
    expect(server.state.snapshot.session.status).toBe('paused');
  } finally { await server.close(); }
});

test('a rejected change rolls the player back and explains why', async ({ page }) => {
  const server = await startHttpFixture({ orderedCommands: true });
  try {
    await connected(page, server);
    server.holdCommandExecution(); server.failNextCommands(1);
    await play(page, true).click();
    await expect(play(page, false)).toBeVisible();
    server.releaseCommandExecution();
    await expect(play(page, true)).toBeEnabled();
    await expect(page.locator('.toast.error')).toContainText('do not allow this action');
    expect(server.commands.map(command => command.command)).toEqual(['pause']);
  } finally { await server.close(); }
});

test('queue edits reorder instantly and chain against each confirmed result', async ({ page }) => {
  const server = await startHttpFixture({ orderedCommands: true });
  try {
    await connected(page, server);
    await expect.poll(() => titles(page)).toEqual(['Night Drive', 'Slow Motion', 'Golden Hour', 'Afterglow']);
    server.holdCommandExecution();
    await songMenu(page, 'Golden Hour', 'Move up');
    await expect.poll(() => titles(page), { timeout: 250 }).toEqual(['Night Drive', 'Golden Hour', 'Slow Motion', 'Afterglow']);
    await songMenu(page, 'Night Drive', 'Remove from queue');
    await expect.poll(() => titles(page), { timeout: 250 }).toEqual(['Golden Hour', 'Slow Motion', 'Afterglow']);
    await expect.poll(() => server.commands.length).toBe(1);
    server.releaseCommandExecution();
    await expect.poll(() => server.commands.map(command => command.command)).toEqual(['move', 'remove']);
    // The queued edit used the revision produced by the confirmed move, not a stale one.
    expect(server.commands[1].expectedRevision).toBe('http-command-revision-1');
    await expect(player(page).getByText('Syncing with Discord…')).toHaveCount(0);
    expect(await titles(page)).toEqual(['Golden Hour', 'Slow Motion', 'Afterglow']);
    expect(server.state.snapshot.session.queue.map(track => track.title)).toEqual(['Golden Hour', 'Slow Motion', 'Afterglow']);
    await expect(page.locator('.toast')).toHaveCount(0);
  } finally { await server.close(); }
});

test('a queued edit is not sent when another listener changes its target first', async ({ page }) => {
  const server = await startHttpFixture({ orderedCommands: true });
  try {
    await connected(page, server);
    server.holdCommandExecution();
    await play(page, true).click();
    await songMenu(page, 'Night Drive', 'Remove from queue');
    await expect.poll(() => titles(page)).toEqual(['Slow Motion', 'Golden Hour', 'Afterglow']);
    // Someone in Discord reorders the queue before this device's edit is sent.
    server.state.snapshot.session.queue.reverse(); server.state.snapshot.revision = 'discord-reorder'; stamp(server.state.snapshot); server.broadcast();
    await expect.poll(() => titles(page)).toEqual(['Afterglow', 'Golden Hour', 'Slow Motion', 'Night Drive']);
    server.releaseCommandExecution();
    await expect(page.locator('.toast.error')).toContainText('The queue changed before your change was sent');
    expect(server.commands.map(command => command.command)).toEqual(['pause']);
    expect(server.state.snapshot.session.queue).toHaveLength(4);
  } finally { await server.close(); }
});

test('volume, loop and filter apply instantly and coalesce repeated adjustments', async ({ page }) => {
  const server = await startHttpFixture({ orderedCommands: true });
  try {
    await connected(page, server);
    server.holdCommandExecution();
    const volume = player(page).getByRole('slider', { name: 'Volume' });
    await volume.focus();
    for (let step = 0; step < 5; step++) await page.keyboard.press('ArrowLeft');
    await expect(volume).toHaveValue('70', { timeout: 250 });
    await player(page).getByRole('button', { name: /^Repeat: off/ }).click();
    await expect(player(page).getByRole('button', { name: /^Repeat: track/ })).toBeVisible({ timeout: 250 });
    await player(page).getByRole('combobox', { name: 'Audio filter' }).selectOption('off');
    await expect(player(page).getByRole('combobox', { name: 'Audio filter' })).toHaveValue('off');
    server.releaseCommandExecution();
    await expect.poll(() => server.state.snapshot.session).toMatchObject({ volume: 70, repeat: 'track', filter: 'off' });
    await expect(player(page).getByText('Syncing with Discord…')).toHaveCount(0);
    const sent = server.commands.map(command => command.command);
    // The first volume step was already in flight; later steps collapse to the newest level.
    expect(sent.filter(name => name === 'volume').length).toBeLessThanOrEqual(2);
    expect(server.commands.filter(command => command.command === 'volume').at(-1)?.options?.level).toBe(70);
    await expect(volume).toHaveValue('70');
  } finally { await server.close(); }
});
