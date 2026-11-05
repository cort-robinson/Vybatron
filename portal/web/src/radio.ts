import type { Command, Track } from './types';

// Seeds this session's autoplay from a chosen song. The bot keeps the human
// queue intact; related songs play after it. Needs an active session and control.
export function startRadioCommand(track: Track): Command | null {
  return track.uri ? { command: 'radio', subcommand: 'on', options: { track: track.uri } } : null;
}
// Song-seeded radio is the session's autoplay: related songs play after the human queue.
export const radioLabel = (track: Track) => `Autoplay from ${track.title}`;
