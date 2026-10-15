import type { GuildSnapshot, SnapshotOrdering } from './types';

// Only a well-formed stamp from a known bridge lifetime can order snapshots.
export const orderingOf = (snapshot: GuildSnapshot | null): SnapshotOrdering | null => {
  const stamp = snapshot?.ordering;
  return stamp && typeof stamp.instanceId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stamp.instanceId)
    && Number.isSafeInteger(stamp.sequence) && stamp.sequence > 0 ? stamp : null;
};
