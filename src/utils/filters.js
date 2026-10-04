import { FilterManager } from 'lavalink-client';

function eq(gains) {
  return Array.from({ length: 15 }, (_, band) => ({ band, gain: gains[band] || 0 }));
}

// These presets only use standard Lavalink filters. Modest EQ and attenuation
// leave headroom instead of turning a bass preset into a volume boost.
export const AUDIO_PRESETS = Object.freeze({
  off: { label: 'Original', description: 'Reset every effect and EQ band.', filters: {}, equalizer: [] },
  bass: {
    label: 'Bass', description: 'A gentle low-end lift with headroom for louder tracks.',
    required: ['equalizer', 'volume'], filters: { volume: 0.84 },
    equalizer: eq([0.08, 0.08, 0.06, 0.03, 0, -0.02]),
  },
  warm: {
    label: 'Warm', description: 'A softer top end for relaxed listening.',
    required: ['equalizer'], filters: {},
    equalizer: eq([0, 0, 0, 0, 0, 0, 0, 0, 0, -0.01, -0.02, -0.04, -0.06, -0.08, -0.08]),
  },
  clarity: {
    label: 'Clarity', description: 'Less low-end rumble and a little more midrange detail.',
    required: ['equalizer', 'volume'], filters: { volume: 0.92 },
    equalizer: eq([-0.06, -0.05, -0.03, -0.01, 0, 0, 0, 0.02, 0.03, 0.04, 0.03, 0.02]),
  },
  nightcore: {
    label: 'Nightcore', description: '12% faster playback with a lightly raised pitch.',
    required: ['timescale'], filters: { timescale: { speed: 1.12, pitch: 1.08, rate: 1 } }, equalizer: [],
  },
  slow: {
    label: 'Slow', description: '15% slower playback with a gently lowered pitch.',
    required: ['timescale'], filters: { timescale: { speed: 0.85, pitch: 0.95, rate: 1 } }, equalizer: [],
  },
  mono: {
    label: 'Mono', description: 'Mix both stereo channels equally into each ear.',
    required: ['channelMix'], filters: {
      channelMix: { leftToLeft: 0.5, leftToRight: 0.5, rightToLeft: 0.5, rightToRight: 0.5 },
    }, equalizer: [],
  },
});

const activePresets = new WeakMap();
const pendingChanges = new WeakMap();

export function getAudioPreset(player) {
  const key = player?.getData?.('vybertron.audioPreset') ?? activePresets.get(player);
  if (AUDIO_PRESETS[key]) return AUDIO_PRESETS[key];
  const manager = player?.filterManager;
  const active = (flags) => Object.values(flags || {}).some((value) => value === true || (value && typeof value === 'object' && active(value)));
  if (manager?.equalizerBands?.some((band) => band?.gain)
    || active(manager?.filters)
    || (manager?.filters?.audioOutput && manager.filters.audioOutput !== 'stereo')) {
    return { label: 'Custom', description: 'Audio-server effects are active.' };
  }
  return AUDIO_PRESETS.off;
}

async function setPreset(player, key) {
  const preset = AUDIO_PRESETS[key];
  if (!preset) return { error: 'Choose one of the available audio presets.' };
  const manager = player?.filterManager;
  if (!manager?.applyPlayerFilters) return { error: 'Audio effects are unavailable for this playback session.' };
  const supported = player.node?.info?.filters;
  if (Array.isArray(supported) && (preset.required || []).some((filter) => !supported.includes(filter))) {
    return { error: `${preset.label} is unavailable on the current audio server. Original always resets effects.` };
  }

  const snapshot = {
    data: manager.data,
    filters: manager.filters,
    equalizerBands: manager.equalizerBands,
    filterUpdatedState: manager.filterUpdatedState,
  };
  const defaults = new FilterManager(player);
  manager.data = { ...defaults.data, ...structuredClone(preset.filters) };
  manager.filters = defaults.filters;
  manager.filters.volume = manager.data.volume !== 1;
  manager.filters.nightcore = key === 'nightcore';
  manager.filters.vaporwave = key === 'slow';
  manager.filters.audioOutput = key === 'mono' ? 'mono' : 'stereo';
  manager.equalizerBands = structuredClone(preset.equalizer);

  try {
    // One request replaces all effects. resetFilters() by itself keeps EQ bands
    // in lavalink-client, and sequential reset/set calls create partial presets.
    await manager.applyPlayerFilters();
  } catch (error) {
    Object.assign(manager, snapshot);
    throw error;
  }

  activePresets.set(player, key);
  player.setData?.('vybertron.audioPreset', key);
  return { key, preset };
}

export async function applyAudioPreset(player, key) {
  if (!player) return { error: 'Nothing is playing. Add something with /play.' };
  const previous = pendingChanges.get(player) || Promise.resolve();
  const operation = previous.catch(() => null).then(() => setPreset(player, key));
  pendingChanges.set(player, operation);
  try {
    return await operation;
  } finally {
    if (pendingChanges.get(player) === operation) pendingChanges.delete(player);
  }
}
