import type { Command, Track } from './types';

// Seeds this session's autoplay from a chosen song. The bot keeps the human
// queue intact; related songs play after it. Needs an active session and control.
export function startRadioCommand(track: Track): Command | null {
  return track.uri ? { command: 'radio', subcommand: 'on', options: { track: track.uri } } : null;
}
export const radioLabel = (track: Track) => `Start radio from ${track.title}`;
