import { refresh, requestControllerRefresh } from './player-controller.js';
import { updateVoiceStatus } from './voice-status.js';
import { updateTrackPresence } from './presence.js';
import { commandTimingSpan } from '../portal/timing.js';

export const PRESENTATION_LIMITS = Object.freeze({ ordinary: 4, terminal: 2, records: 256 });
const writes = new Map();
let retired = new WeakSet();
let ordinary = 0;
let terminal = 0;
let pumping = false;
let drops = 0;
let failures = 0;

export function presentationPlayerActive(client, player) {
  if (!player || retired.has(player) || player.getData?.('vybertron.stopping')
    || player.getData?.('internal_destroystatus')) return false;
  const manager = client.lavalink || player.LavalinkManager;
  return typeof manager?.getPlayer !== 'function' || manager.getPlayer(player.guildId) === player;
}

export function retirePresentationPlayer(player) {
  if (player) retired.add(player);
}

export function recordPresentationDrop() { drops += 1; }
export function recordPresentationFailure() { failures += 1; }
export function presentationWritePending(key) { return writes.has(key); }

function requestPump() {
  if (pumping) return;
  pumping = true;
  queueMicrotask(() => { pumping = false; pump(); });
}

function pump() {
  // Terminal reservations do not preempt an already submitted REST request.
  for (const [key, record] of writes) {
    if (record.running || !record.latest) continue;
    const reserved = record.latest.terminal && terminal < PRESENTATION_LIMITS.terminal;
    if (!reserved && ordinary >= PRESENTATION_LIMITS.ordinary) continue;
    const intent = record.latest;
    record.latest = null;
    record.running = true;
    if (reserved) terminal += 1; else ordinary += 1;
    // No timeout releases ownership: the actual network promise must settle.
    void Promise.resolve().then(intent.operation).catch(() => {
      recordPresentationFailure();
      return null;
    }).then(result => {
      record.result = result;
      record.running = false;
      if (reserved) terminal -= 1; else ordinary -= 1;
      if (!record.latest) {
        writes.delete(key);
        record.resolve(record.result);
      }
      requestPump();
    });
  }
}

// One shared completion promise per busy address, one current and one latest
// intent. Ignored producers must submit synchronously without attaching a
// completion reaction. Only bounded native callers await the shared drain.
export function submitPresentationWrite(key, operation, { terminal: ending = false, onRejected } = {}) {
  let record = writes.get(key);
  if (!record) {
    if (writes.size >= PRESENTATION_LIMITS.records) {
      recordPresentationDrop();
      onRejected?.();
      return Promise.resolve(null);
    }
    let resolve;
    const completion = new Promise(done => { resolve = done; });
    record = { running: false, latest: null, completion, resolve, result: null };
    writes.set(key, record);
  }
  record.latest = { operation, terminal: ending };
  requestPump();
  return record.completion;
}

export function requestRefresh(client, player, { controller = true, voice = false, presence = false } = {}) {
  if (!presentationPlayerActive(client, player)) return false;
  try {
    if (presence) updateTrackPresence(client, player);
    // These submit synchronously to the observed writer. Do not attach a
    // per-command completion reaction to a potentially never-settling write.
    if (controller) requestControllerRefresh(client, player);
    if (voice) updateVoiceStatus(client, player);
    return true;
  } catch {
    recordPresentationFailure();
    return false;
  }
}

export async function directControlPresentation(interaction, player, { voice = false, presence = false } = {}) {
  if (!presentationPlayerActive(interaction.client, player)) return;
  if (typeof interaction.portalRecheck === 'function') {
    requestRefresh(interaction.client, player, { voice, presence });
    return;
  }
  if (presence) updateTrackPresence(interaction.client, player);
  await commandTimingSpan('presentation', () => refresh(interaction.client, player));
  if (voice) await commandTimingSpan('presentation', () => updateVoiceStatus(interaction.client, player));
}

export function getPresentationDiagnostics() {
  return { records: writes.size, ordinary, terminal, drops, failures };
}

export function resetPresentationUpdates() {
  if (writes.size) throw new Error('Presentation writes must settle before reset.');
  retired = new WeakSet();
  drops = 0;
  failures = 0;
}
