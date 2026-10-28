import { expect, test } from './test';
import { applyIntents, createIntent, displayedPosition, stillTargets } from '../src/optimistic';
import { fixtureState } from './fixtures';

const verified = () => fixtureState().snapshot;
const ids = (snapshot: ReturnType<typeof verified>) => snapshot.session.queue.map(track => track.title);

test('set-state controls predict immediately, carry no revision and skip no-ops', () => {
  const base = verified(); const now = 10_000;
  const pause = createIntent(1, { command: 'pause', expectedRevision: base.revision }, base, base, now - 2000, now)!;
  expect(pause.command).toEqual({ command: 'pause' });
  const paused = applyIntents(base, now - 2000, [pause]);
  expect(paused.snapshot.session.status).toBe('paused');
  // The paused position is where the user saw playback when they pressed it.
  expect(paused.snapshot.session.positionMs).toBe(base.session.positionMs + 2000);
  expect(createIntent(2, { command: 'pause' }, paused.snapshot, base, paused.receivedAt, now)).toBeNull();
  expect(createIntent(3, { command: 'volume', options: { level: base.session.volume } }, base, base, now, now)).toBeNull();
  // Revision and permissions always come from verified state.
  expect(paused.snapshot.revision).toBe(base.revision);
  expect(paused.snapshot.session.canControl).toBe(base.session.canControl);
});

test('set-state predictions survive newer verified state until they settle', () => {
  const base = verified();
  const volume = createIntent(1, { command: 'volume', options: { level: 30 } }, base, base, 0, 0)!;
  const later = { ...verified(), revision: 'someone-else-added-a-song' };
  expect(applyIntents(later, 0, [volume]).snapshot.session.volume).toBe(30);
});

test('queue predictions chain, then stop applying once verified state moves on', () => {
  const base = verified();
  const move = createIntent(1, { command: 'move', options: { from: 3, to: 2 } }, base, base, 0, 0)!;
  const afterMove = applyIntents(base, 0, [move]).snapshot;
  expect(ids(afterMove)).toEqual(['Night Drive', 'Golden Hour', 'Slow Motion', 'Afterglow']);
  const skip = createIntent(2, { command: 'skip' }, afterMove, base, 0, 0)!;
  const shown = applyIntents(base, 0, [move, skip]).snapshot;
  expect(shown.session.current?.title).toBe('Night Drive');
  expect(ids(shown)).toEqual(['Golden Hour', 'Slow Motion', 'Afterglow']);
  expect(shown.session.positionMs).toBe(0);
  const changed = { ...verified(), revision: 'discord-changed-it' };
  expect(ids(applyIntents(changed, 0, [move, skip]).snapshot)).toEqual(ids(base));
});

test('skip is not predicted when repeating one song or an empty queue makes the next track a server decision', () => {
  const repeat = verified(); repeat.session.repeat = 'track';
  const skip = createIntent(1, { command: 'skip' }, repeat, repeat, 0, 0)!;
  expect(applyIntents(repeat, 0, [skip]).snapshot.session.current?.title).toBe('Evening Light');
  const empty = verified(); empty.session.queue = [];
  expect(applyIntents(empty, 0, [createIntent(2, { command: 'skip' }, empty, empty, 0, 0)!]).snapshot.session.current?.title).toBe('Evening Light');
});

test('a queued edit only targets the exact tracks the user acted on', () => {
  const base = verified();
  const remove = createIntent(1, { command: 'remove', options: { position: 1 } }, base, base, 0, 0)!;
  expect(stillTargets(remove, base)).toBe(true);
  const reordered = verified(); reordered.session.queue.reverse();
  expect(stillTargets(remove, reordered)).toBe(false);
  const pause = createIntent(2, { command: 'pause' }, base, base, 0, 0)!;
  expect(stillTargets(pause, reordered)).toBe(true);
});

test('repeating the queue sends the skipped song to its end, and skip-to drops the songs passed over', () => {
  const repeat = verified(); repeat.session.repeat = 'queue';
  const skipped = applyIntents(repeat, 0, [createIntent(1, { command: 'skip' }, repeat, repeat, 0, 0)!]).snapshot;
  expect(skipped.session.current?.title).toBe('Night Drive');
  expect(ids(skipped)).toEqual(['Slow Motion', 'Golden Hour', 'Afterglow', 'Evening Light']);
  const jumped = applyIntents(repeat, 0, [createIntent(2, { command: 'skipto', options: { position: 3 } }, repeat, repeat, 0, 0)!]).snapshot;
  expect(jumped.session.current?.title).toBe('Golden Hour');
  expect(ids(jumped)).toEqual(['Afterglow', 'Evening Light']);
});

test('a predicted skip holds the next song at its start until the bot confirms it', () => {
  const base = verified();
  const skipped = applyIntents(base, 0, [createIntent(1, { command: 'skip' }, base, base, 0, 0)!]);
  expect(skipped.snapshot.session.starting).toBe(true);
  expect(displayedPosition(skipped.snapshot, skipped.receivedAt, 5000)).toBe(0);
});

test('Play next with a chosen song goes to the front and binds to the queue shown', () => {
  const base = verified(); const song = { ...base.session.queue[0], id: 'chosen', title: 'Chosen' };
  const next = createIntent(1, { command: 'playnext', options: { query: song.uri! } }, base, base, 0, 0, song)!;
  expect(ids(applyIntents(base, 0, [next]).snapshot)[0]).toBe('Chosen');
  expect(stillTargets(next, base)).toBe(true);
  const changed = verified(); changed.session.queue.reverse();
  expect(stillTargets(next, changed)).toBe(false);
  // Unsent, it still shows over newer state; the bot's reply settles it.
  expect(ids(applyIntents({ ...changed, revision: 'newer' }, 0, [next]).snapshot)[0]).toBe('Chosen');
});

test('suggestion edits find their pick by id and keep showing until sent', () => {
  const base = verified(); base.session.suggestions = [{ ...base.session.queue[0], id: 'pick-1', title: 'Pick one' }, { ...base.session.queue[1], id: 'pick-2', title: 'Pick two' }];
  const remove = createIntent(1, { command: 'radio', subcommand: 'remove', options: { position: 2 }, expectedTrackId: 'pick-2' }, base, base, 0, 0)!;
  expect(remove.slot).toBeNull();
  const promote = createIntent(2, { command: 'radio', subcommand: 'promote', options: { position: 1 }, expectedTrackId: 'pick-1' }, base, base, 0, 0)!;
  const shown = applyIntents({ ...base, revision: 'newer' }, 0, [remove, promote]).snapshot;
  expect(shown.session.suggestions).toEqual([]);
  expect(ids(shown).at(-1)).toBe('Pick one');
  // A pick that's already gone changes nothing.
  const gone = verified(); gone.session.suggestions = [];
  expect(applyIntents(gone, 0, [remove]).snapshot.session.suggestions).toEqual([]);
});
