const states = new WeakMap();

function stateFor(client) {
  if (!states.has(client)) states.set(client, { until: 0, inFlight: 0 });
  return states.get(client);
}

export function maintenanceStatus(client) {
  const state = stateFor(client);
  const queued = [...(client.lavalink?.players?.values() || [])].some((player) =>
    player.playing || player.paused || player.queue?.current || player.queue?.tracks?.length);
  return { active: state.until > Date.now(), inFlight: state.inFlight, busy: queued };
}

export function setMaintenance(client, active) {
  // A crashed updater must never leave /play disabled indefinitely.
  stateFor(client).until = active ? Date.now() + 15 * 60_000 : 0;
  return maintenanceStatus(client);
}

export function acquirePlaybackRequest(client) {
  const state = stateFor(client);
  if (state.until > Date.now()) return null;
  state.inFlight++;
  let released = false;
  return () => {
    if (!released) state.inFlight--;
    released = true;
  };
}
