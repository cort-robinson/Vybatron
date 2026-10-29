// A stand-in for the portal's shared player (ADR-0018, docs/portal-contract.md) for mock specs:
// the store's entry-based edits, generations and reports, the device list, listener
// streams on each attached page, and controls relayed to the device that plays.
// Explicit loopback test code; not imported by src or emitted in production.
import type { Page, Route } from '@playwright/test';
import { randomBytes } from 'node:crypto';

type Repeat = 'off' | 'track' | 'queue';
export interface HubTrack { id: string; title: string; author: string; uri: string; source: string; durationMs: number; artworkUrl: string | null; isStream: boolean }
export interface HubEntry { entryId: string; track: HubTrack }
export interface HubPlayer {
  guildId: string | null; revision: number; generation: number; generationAt: number; activeDeviceId: string | null; playbackVersion: number;
  current: HubEntry | null; queue: HubEntry[]; history: HubEntry[]; playhead: { positionMs: number; at: number; playing: boolean }; volume: number; repeat: Repeat;
  updatedAt: number; reportSeq: number;
}
interface HubDevice { deviceId: string; name: string; kind: string; lastSeen: number }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;
export interface HubRequest { deviceId: string | null; body: Body; status: number }

const entryId = () => randomBytes(9).toString('base64url');
const own = ({ id, title, author, uri, source = 'unknown', durationMs, artworkUrl = null, isStream = false }: HubTrack): HubTrack => ({ id, title, author, uri, source, durationMs, artworkUrl, isStream });
// A page binds its stream callback once; a spec that mocks the portal again on it moves the binding to the new hub.
const bound = new WeakMap<Page, SharedPlayerHub>();
class Refusal extends Error { constructor(public status: number, public code: string, message: string, public withPlayer = false) { super(message); } }

export class SharedPlayerHub {
  player: HubPlayer = { guildId: null, revision: 0, generation: 0, generationAt: 0, activeDeviceId: null, playbackVersion: 0, current: null, queue: [], history: [],
    playhead: { positionMs: 0, at: 0, playing: false }, volume: 100, repeat: 'off', updatedAt: 0, reportSeq: 0 };
  devices: HubDevice[] = [];
  requests: HubRequest[] = [];
  // The device each page's open listener stream registered, per page.
  private streams = new Map<Page, string[]>();
  private staleEdits = 0;
  private holding = false;

  /** Page-side wiring: its listener stream reports opening and closing here. */
  async attach(page: Page) {
    this.streams.set(page, []);
    page.on('close', () => { this.streams.delete(page); void this.publish(); });
    const known = bound.has(page);
    bound.set(page, this);
    if (!known) await page.exposeFunction('portalMeStream', (url: string, open: boolean) => bound.get(page)?.stream(page, url, open));
  }
  // Refuse the next `count` edits as stale, as if another device had just changed the queue.
  staleNext(count = 1) { this.staleEdits = count; }
  // Streams open but deliver nothing until released, as before a slow first connection.
  holdStreams() { this.holding = true; }
  async releaseStreams() { this.holding = false; await this.publish(); }
  ops(op: string) { return this.requests.filter(request => request.body.op === op); }
  deviceOf(page: Page) { return this.streams.get(page)?.[0] ?? null; }

  view() {
    const connected = new Set([...this.streams.values()].flat());
    return { player: structuredClone(this.player), devices: this.devices.map(device => ({ ...device, connected: connected.has(device.deviceId), active: device.deviceId === this.player.activeDeviceId })) };
  }
  private touch() { this.player.updatedAt = Math.max(Date.now(), this.player.updatedAt + 1); }
  async publish() {
    if (this.holding) return;
    const view = this.view();
    await Promise.all([...this.streams].filter(([, ids]) => ids.length).map(([page]) => page.evaluate(data => (window as unknown as { portalTest: { emitPlayer: (data: unknown) => void } }).portalTest.emitPlayer(data), view).catch(() => undefined)));
  }
  private async stream(page: Page, url: string, open: boolean) {
    const query = new URL(url, 'http://127.0.0.1').searchParams; const deviceId = query.get('device')!;
    const ids = this.streams.get(page) ?? [];
    if (open) {
      const known = this.devices.find(device => device.deviceId === deviceId);
      if (known) Object.assign(known, { name: query.get('name'), kind: query.get('kind'), lastSeen: Date.now() });
      else this.devices.push({ deviceId, name: query.get('name')!, kind: query.get('kind')!, lastSeen: Date.now() });
      this.streams.set(page, [...ids, deviceId]); this.touch();
    } else {
      const at = ids.indexOf(deviceId);
      if (at >= 0) this.streams.set(page, ids.filter((_, index) => index !== at));
    }
    await this.publish();
  }

  async handle(page: Page, route: Route) {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (path === '/api/me/time') { await route.fulfill({ json: { now: Date.now() } }); return; }
    if (path !== '/api/me/player' || request.method() !== 'POST') { await route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not found.' } } }); return; }
    if (request.headers()['x-csrf-token'] !== 'local-test-csrf') throw new Error('The player needs a CSRF-checked POST');
    const body = request.postDataJSON() as Body;
    const record: HubRequest = { deviceId: this.deviceOf(page), body, status: 200 }; this.requests.push(record);
    try {
      if (body.op === 'control' && this.player.activeDeviceId) {
        const target = [...this.streams].find(([, ids]) => ids.includes(this.player.activeDeviceId!))?.[0];
        if (target) {
          const command = { action: body.action, ...(body.value !== undefined && { value: body.value }), generation: this.player.generation };
          await target.evaluate(data => (window as unknown as { portalTest: { emitCommand: (data: unknown) => void } }).portalTest.emitCommand(data), command).catch(() => undefined);
          await route.fulfill({ json: { ok: true, relayed: true } }); return;
        }
      }
      const extra = this.apply(body) || {};
      this.touch();
      await route.fulfill({ json: { ok: true, relayed: false, ...this.view(), ...extra } });
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      record.status = error.status;
      await route.fulfill({ status: error.status, json: { error: { code: error.code, message: error.message }, ...(error.withPlayer && { player: structuredClone(this.player) }) } });
    }
    await this.publish();
  }

  private position() {
    const { positionMs, at, playing } = this.player.playhead;
    const position = playing ? positionMs + Math.max(0, Date.now() - at) : positionMs;
    const duration = this.player.current?.track.durationMs;
    return Math.floor(duration ? Math.min(position, duration) : position);
  }
  private setCurrent(entry: HubEntry | null, playing: boolean) {
    this.player.current = entry;
    this.player.playhead = { positionMs: 0, at: Date.now(), playing: !!(entry && playing && this.player.activeDeviceId) };
    this.player.playbackVersion++;
  }
  private retire(entry: HubEntry) { this.player.history = [entry, ...this.player.history.filter(item => item.entryId !== entry.entryId)].slice(0, 50); }
  private apply(body: Body): Body | void {
    const player = this.player; const queue = player.queue;
    const index = (list: HubEntry[], id: string) => list.findIndex(item => item.entryId === id);
    if (['add', 'remove', 'move', 'clear', 'shuffle', 'play', 'skipTo'].includes(body.op)) {
      if (this.staleEdits > 0) { this.staleEdits--; player.revision++; this.touch(); throw new Refusal(409, 'stale', 'Your queue changed. Try again.', true); }
      if (body.expectedRevision !== player.revision) throw new Refusal(409, 'stale', 'Your queue changed. Try again.', true);
      if (body.guildId) player.guildId = body.guildId;
      const unknown = () => new Refusal(400, 'unknown_entry', 'That song is no longer in your queue.');
      if (body.op === 'add') {
        const list = (body.tracks as HubTrack[]).map(track => ({ entryId: entryId(), track: own(track) }));
        if (queue.length + list.length - (player.current ? 0 : 1) > 500) throw new Refusal(400, 'queue_full', 'Your queue is full.');
        let at = body.position === 'end' ? queue.length : 0;
        if (body.position.after && body.position.after !== player.current?.entryId) { at = index(queue, body.position.after) + 1; if (!at) throw unknown(); }
        if (!player.current) this.setCurrent(list.shift()!, false);
        queue.splice(at, 0, ...list);
      } else if (body.op === 'remove') { const at = index(queue, body.entryId); if (at < 0) throw unknown(); queue.splice(at, 1); }
      else if (body.op === 'move') {
        const from = index(queue, body.entryId);
        if (from < 0 || (body.before !== null && index(queue, body.before) < 0)) throw unknown();
        const [entry] = queue.splice(from, 1); queue.splice(body.before === null ? queue.length : index(queue, body.before), 0, entry);
      } else if (body.op === 'clear') queue.length = 0;
      else if (body.op === 'shuffle') queue.reverse();
      else if (body.op === 'play') {
        const list = (body.tracks as HubTrack[]).map(track => ({ entryId: entryId(), track: own(track) }));
        if (player.current) this.retire(player.current);
        this.setCurrent(list[body.startIndex], true); player.queue = list.slice(body.startIndex + 1);
      } else if (body.op === 'skipTo') {
        const at = index(queue, body.entryId); if (at < 0) throw unknown();
        if (player.current) this.retire(player.current);
        this.setCurrent(queue[at], player.playhead.playing); player.queue = queue.slice(at + 1);
      }
      player.revision++;
      return;
    }
    if (body.op === 'report') {
      if (body.generation !== player.generation || body.deviceId !== player.activeDeviceId) throw new Refusal(409, 'replaced', 'Another device is playing now.', true);
      if (body.seq <= player.reportSeq) return;
      player.reportSeq = body.seq;
      const { advance, playhead } = body;
      if (advance && advance.to !== (player.current?.entryId ?? null)) {
        let next: HubEntry | null = null; let back = false;
        if (advance.to !== null) {
          let at = index(player.queue, advance.to);
          if (at >= 0) [next] = player.queue.splice(at, 1);
          else if ((at = index(player.history, advance.to)) >= 0) { [next] = player.history.splice(at, 1); back = true; }
          else if (advance.track) next = { entryId: advance.to, track: own(advance.track) };
          else throw new Refusal(400, 'unknown_entry', 'That song is no longer in your queue.');
        }
        const done = player.current;
        if (done && !back && done.entryId === advance.from) { this.retire(done); if (player.repeat === 'queue') player.queue.push({ entryId: entryId(), track: done.track }); }
        else if (done) player.queue.unshift(done);
        this.setCurrent(next, true); player.revision++;
      }
      if (playhead && playhead.entryId === (player.current?.entryId ?? null)) {
        if (playhead.playing !== player.playhead.playing) player.playbackVersion++;
        player.playhead = { positionMs: playhead.positionMs, at: playhead.at, playing: playhead.playing && !!player.current };
      }
      if (body.volume !== undefined) player.volume = body.volume;
      if (body.repeat !== undefined) player.repeat = body.repeat;
      return;
    }
    if (body.op === 'activate') {
      if (!this.devices.some(device => device.deviceId === body.deviceId)) throw new Refusal(404, 'unknown_device', 'That device is no longer signed in.');
      if (body.guildId) player.guildId = body.guildId;
      player.playhead = { positionMs: this.position(), at: Date.now(), playing: player.playhead.playing };
      player.generation++; player.generationAt = Date.now(); player.activeDeviceId = body.deviceId; player.reportSeq = 0; player.playbackVersion++;
      return;
    }
    if (body.op === 'deactivate') {
      if (body.generation !== player.generation || body.deviceId !== player.activeDeviceId) throw new Refusal(409, 'replaced', 'Another device is playing now.', true);
      player.playhead = { positionMs: this.position(), at: Date.now(), playing: false }; player.activeDeviceId = null;
      return;
    }
    if (body.op === 'control') {
      // No device that plays is connected: the stored player changes.
      if (body.action === 'pause') player.playhead = { positionMs: this.position(), at: Date.now(), playing: false };
      else if (body.action === 'play' && !player.current && queue.length) { this.setCurrent(queue.shift()!, false); player.revision++; }
      else if (body.action === 'seek' && player.current) player.playhead = { ...player.playhead, positionMs: body.value, at: Date.now() };
      else if (body.action === 'next' && (player.current || queue.length)) { if (player.current) this.retire(player.current); this.setCurrent(queue.shift() ?? null, player.playhead.playing); player.revision++; }
      else if (body.action === 'volume') player.volume = body.value;
      else if (body.action === 'repeat') player.repeat = body.value;
      return;
    }
    if (body.op === 'adopt') {
      const list = [...(body.current ? [body.current] : []), ...(body.tracks || [])].map((track: HubTrack) => ({ entryId: entryId(), track: own(track) }));
      if (!player.current) {
        this.setCurrent(list.shift() ?? null, false);
        if (body.current) player.playhead.positionMs = body.positionMs ?? 0;
        if (body.volume !== undefined) player.volume = body.volume;
        if (body.repeat !== undefined) player.repeat = body.repeat;
      }
      const room = Math.max(0, 500 - queue.length);
      queue.push(...list.slice(0, room)); player.revision++;
      return { dropped: Math.max(0, list.length - room) };
    }
    if (body.op === 'rename') {
      const device = this.devices.find(item => item.deviceId === body.deviceId);
      if (!device) throw new Refusal(404, 'unknown_device', 'That device is no longer signed in.');
      device.name = body.name;
      return;
    }
    throw new Refusal(400, 'invalid_input', 'That player change is invalid.');
  }
}
