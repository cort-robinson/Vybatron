import { expect, test } from './test';
import { orderingOf } from '../src/ordering';
import { fixtureState } from './fixtures';

const instance = '748c50dc-f3f0-4bb5-8b57-692912648dc6';
const withStamp = (ordering: unknown) => ({ ...fixtureState().snapshot, ordering }) as Parameters<typeof orderingOf>[0];

test('only a UUID instance with a positive safe-integer sequence orders snapshots', () => {
  expect(orderingOf(withStamp({ instanceId: instance, sequence: 3 }))).toEqual({ instanceId: instance, sequence: 3 });
  for (const ordering of [undefined, null, { instanceId: 'unknown-bridge', sequence: 3 }, { instanceId: instance, sequence: '3' },
    { instanceId: instance, sequence: 3.5 }, { instanceId: instance, sequence: Number.MAX_SAFE_INTEGER + 1 }, { instanceId: instance, sequence: 0 }]) {
    expect(orderingOf(withStamp(ordering)), JSON.stringify(ordering)).toBeNull();
  }
  expect(orderingOf(null)).toBeNull();
});
