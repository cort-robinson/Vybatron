import { MessageFlags } from 'discord.js';
import { acquirePlaybackRequest } from './maintenance.js';
import { trackReference } from './library.js';

const mutations = new Map();
const MAX_PENDING = 12;

export function cancelGuildMutations(guildId) {
  const state = mutations.get(guildId);
  if (state) {
    state.epoch++;
    // A new session gets its own lane immediately. Old callbacks retain their
    // cancellation epoch and player fences until their bounded lookup finishes.
    mutations.delete(guildId);
  }
}

// One FIFO turn on a lane chain: `ready` settles when every earlier holder has
// released, and release() lets the next one in. A chain never rejects.
function turn(state, chain) {
  let release;
  const done = new Promise(resolve => { release = resolve; });
  const ready = state[chain];
  state[chain] = ready.then(() => done);
  return { ready, release };
}

// Every guild mutation holds the playback lane while it runs. An `ordered`
// mutation (an addition) also keeps its place among additions, so it may step
// out of the playback lane for a slow lookup (outsideLane) without letting a
// later addition overtake it; Pause or Skip run meanwhile. It re-enters at the
// back of the lane, and Stop's cancellation still applies on re-entry.
export async function withGuildMutation(guildId, operation, { ordered = false } = {}) {
  let state = mutations.get(guildId);
  if (!state) { state = { pending: 0, tail: Promise.resolve(), additions: Promise.resolve(), epoch: 0 }; mutations.set(guildId, state); }
  if (state.pending >= MAX_PENDING) throw new Error('The music queue is busy. Wait a moment before trying again.');
  state.pending++;
  const epoch = state.epoch;
  const live = () => { if (state.epoch !== epoch) throw new Error('The queued music request was cancelled by Stop.'); };
  const order = ordered ? turn(state, 'additions') : null;
  let lane = null;
  const enter = async () => { lane = turn(state, 'tail'); await lane.ready; live(); };
  const leave = () => { const held = lane; lane = null; held?.release(); };
  try {
    if (order) { await order.ready; live(); }
    await enter();
    return await operation({
      outsideLane: ordered ? async work => { leave(); const result = await work(); await enter(); return result; } : null,
    });
  } finally {
    leave(); order?.release();
    state.pending--;
    if (state.pending === 0 && mutations.get(guildId) === state) mutations.delete(guildId);
  }
}

export async function acknowledgeMutation(interaction) {
  if (interaction.deferred || interaction.replied) return;
  if (interaction.isModalSubmit?.()) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  else if (interaction.isMessageComponent?.()) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
}

// Commands remain usable directly in tests; in dispatch this proxy lets them
// reply after a defer while waiting their turn, without losing Discord's token.
export function deferredInteraction(interaction) {
  return new Proxy(interaction, {
    get(target, property) {
      if (property === 'reply') return async payload => {
        if (!target.deferred && !target.replied) return target.reply(payload);
        const { flags, ...edit } = typeof payload === 'string' ? { content: payload } : payload;
        if (target.deferred && !target.isMessageComponent?.()) return target.editReply(edit);
        return target.followUp(payload);
      };
      if (property === 'deferReply') return async payload => { if (!target.deferred && !target.replied) await target.deferReply(payload); };
      if (property === 'deferUpdate') return async () => { if (!target.deferred && !target.replied) await target.deferUpdate(); };
      if (property === 'update') return async payload => target.deferred ? target.editReply(payload) : target.update(payload);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function commandMutationPolicy(name, action) {
  const readOnly = ['queue', 'nowplaying', 'help', 'history', 'invite', 'lyrics'].includes(name)
    || (['favorite', 'mix', 'session', 'settings', 'top', 'mymix', 'sleep'].includes(name) && ['list', 'show'].includes(action))
    // An import preview only reads; its confirmation is a library write.
    || (['favorite', 'mix'].includes(name) && action === 'import');
  const libraryOnly = (['favorite', 'mix'].includes(name) && !['play', 'load'].includes(action)) || name === 'settings';
  // /play looks its song up outside the playback lane when a session exists.
  return { readOnly, playback: !libraryOnly, urgent: name === 'stop' || (name === 'radio' && action === 'off'), ...(name === 'play' && { lookupOutsideLane: true }) };
}

function activityState(interaction) {
  if (!interaction.client.library?.recordActivity || interaction.commandName === 'favorite' || interaction.customId?.includes('favorite')) return null;
  const name = interaction.commandName;
  const action = interaction.options?.getSubcommand?.(false);
  const queueEdit = ['play', 'playnext', 'transfer', 'clear', 'remove', 'move', 'shuffle', 'skip', 'skipto', 'back', 'stop', 'replay', 'voteskip'].includes(name)
    || (['mix', 'top', 'mymix'].includes(name) && ['load', 'play'].includes(action)) || (name === 'radio' && action === 'promote') || (name === 'session' && ['resume', 'discard'].includes(action))
    || /^(?:queue:.*:jump:|history:.*:replay:|player:v1:(?:skip|back|shuffle|stop-confirm)$)/.test(interaction.customId || '');
  if (name !== 'settings' && !queueEdit) return null;
  const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
  return JSON.stringify(name === 'settings' ? interaction.client.library.settings(interaction.guildId)
    : [Boolean(player), [player?.queue?.current, ...(player?.queue?.tracks || [])].map(trackReference), interaction.client.library.readGuild(interaction.guildId).session?.tracks]);
}

export async function guardedMutation(interaction, operation, { playback = false, urgent = false, lookupOutsideLane = false, beforeMutation } = {}) {
  const release = playback ? acquirePlaybackRequest(interaction.client) : null;
  if (playback && !release) {
    if (interaction.portalUnavailable) return interaction.portalUnavailable();
    return interaction.reply({ content: 'Vybatron is briefly updating its playback service. Try again in a minute.', flags: MessageFlags.Ephemeral });
  }
  try {
    await acknowledgeMutation(interaction);
    const run = async lane => {
      await beforeMutation?.(interaction);
      let before = activityState(interaction);
      if (lane?.outsideLane) {
        interaction.outsideMutationLane = async work => {
          const left = activityState(interaction);
          const result = await lane.outsideLane(work);
          // Changes others made meanwhile aren't this request's activity.
          const entered = activityState(interaction);
          if (entered !== left) before = entered;
          return result;
        };
      }
      let result;
      try { result = await operation(deferredInteraction(interaction)); } finally { delete interaction.outsideMutationLane; }
      if (before !== null && before !== activityState(interaction)) {
        // Started inside the lane, so activity is recorded in lane order and
        // library shutdown still waits for it, but the lane doesn't wait on the
        // library's durable write (which can queue behind a library.json fsync).
        void interaction.client.library.recordActivity(interaction.guildId, interaction.user, interaction.commandName === 'settings' ? 'settings' : 'queue')
          .catch(() => console.error('[Library] Could not save actor activity.'));
      }
      return result;
    };
    // Stop must stay responsive even while a catalog import is still loading.
    // Enqueue paths recheck the player identity and stopping flag after lookup.
    return await (urgent ? run() : withGuildMutation(interaction.guildId, run, { ordered: lookupOutsideLane }));
  } finally { release?.(); }
}
