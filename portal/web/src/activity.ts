import { DiscordSDK } from '@discord/embedded-app-sdk';
import { defaultPalette } from './art';
import { startVisualizer, type Visualizer, type View } from './visualizer/engine';
import { loadEnergy } from './visualizer/analysis';
import './activity.css';

type Room = { track: { id: string; title: string; artist: string; video: string | null } | null; playing: boolean; positionMs: number; rate: number };
const element = (id: string) => document.getElementById(id)!;
const canvas = document.querySelector('canvas')!;
const lifetime = new AbortController();
let engine: Visualizer | null = null;
let view: View | null = null;
let animate = !matchMedia('(prefers-reduced-motion: reduce)').matches;
let token = '';

function clear(message: string) {
  engine?.stop(); engine = null; view = null;
  canvas.hidden = true; element('controls').hidden = true;
  element('source').textContent = 'Room visualizer'; element('preset').textContent = '';
  element('title').textContent = message; element('artist').textContent = '';
}

function show(room: Room, guild: string) {
  if (!room.track) { clear('Waiting for the next song'); return; }
  canvas.hidden = false;
  element('title').textContent = room.track.title; element('artist').textContent = room.track.artist;
  if (!engine) {
    engine = startVisualizer(canvas, true, {
      fail: () => { element('source').textContent = 'Graphics unavailable on this device'; element('controls').hidden = true; },
      sourced: source => { element('source').textContent = source === 'live' ? 'Song energy' : 'Ambient motion'; },
      named: name => { element('preset').textContent = name; },
    }, (guildId, video, signal) => loadEnergy(`/.proxy/room/${guildId}/${video}`, signal, { Authorization: `Bearer ${token}` }));
    element('controls').hidden = !engine;
  }
  const previous = view;
  view = { preset: 'milkdrop', seed: room.track.id, guildId: guild, video: room.track.video, playing: room.playing,
    positionMs: room.positionMs, at: Date.now(), rate: room.rate, lagMs: 0, palette: defaultPalette, full: true, lite: false, animate };
  if (animate || previous?.seed !== view.seed) engine?.update(view);
}

element('next').onclick = () => engine?.next();
function motionLabel() { element('motion').textContent = animate ? 'Pause motion' : 'Resume motion'; }
element('motion').onclick = () => {
  animate = !animate; motionLabel();
  if (view) engine?.update({ ...view, animate });
};
motionLabel();
window.addEventListener('pagehide', () => { lifetime.abort(); engine?.stop(); token = ''; }, { once: true });

async function start() {
  const app = /^(\d+)\.discordsays\.com$/.exec(location.hostname)?.[1];
  if (!app) { clear('Open the visualizer from the Discord player'); return; }
  const sdk = new DiscordSDK(app);
  await sdk.ready();
  const guild = sdk.guildId;
  if (!guild) { clear('Open the visualizer in a server listening room'); return; }
  async function signIn() {
    const { code } = await sdk.commands.authorize({ client_id: app!, response_type: 'code', scope: ['identify'], state: '', prompt: 'none' });
    const response = await fetch('/.proxy/token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }), signal: lifetime.signal });
    if (!response.ok) throw new Error();
    const session = await response.json();
    if (!await sdk.commands.authenticate({ access_token: session.access_token })) throw new Error();
    token = session.token;
  }
  await signIn();
  async function poll() {
    if (lifetime.signal.aborted) return;
    try {
      const read = () => fetch(`/.proxy/room/${guild}`, { headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]) });
      let response = await read();
      if (response.status === 401) { await signIn(); response = await read(); }
      if (response.ok) show(await response.json() as Room, guild!);
      else clear(response.status === 403 ? 'Join the bot’s voice channel to see this room' : 'Waiting for the player');
    } catch { clear('Reconnecting to the player…'); }
    if (!lifetime.signal.aborted) window.setTimeout(poll, 5000);
  }
  await poll();
}
void start().catch(() => clear('Reconnect by opening the visualizer from the player'));
