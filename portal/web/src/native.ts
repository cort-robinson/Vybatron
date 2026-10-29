import type { Track } from './types';

// The Android app's bridge (portal/android, ADR-0016): `window.vybatronNative`,
// present only when the portal runs inside the app. Each request gets one reply;
// the app also sends events, which carry no id.
interface Port {
  postMessage(data: string): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}
declare global { interface Window { vybatronNative?: Port } }

export type NativeRepeat = 'off' | 'track' | 'queue';
export interface NativeState {
  revision: number; current: Track | null; queue: Track[]; history: Track[];
  status: 'idle' | 'playing' | 'paused'; positionMs: number; at: number; waiting: boolean;
  durationMs: number; volume: number; repeat: NativeRepeat;
}
export interface NativeLoad {
  guildId: string; current: Track | null; queue: Track[]; history: Track[];
  positionMs: number; playing: boolean; volume: number; repeat: NativeRepeat;
}
export type NativeControl = { action: 'play' | 'pause' | 'next' | 'previous' | 'stop' } | { action: 'seek'; positionMs: number }
  | { action: 'skipTo'; index: number; revision: number } | { action: 'volume'; level: number } | { action: 'repeat'; mode: NativeRepeat };

// What the page hands the app's playback service so it can reach the shared player by itself (ADR-0018).
export interface NativeSession { csrfToken: string; deviceId: string; name: string; guildId?: string }
// `features`: 'player.shared' when the app keeps its own connection to the shared player and reports for this device.
export interface NativeInfo { platform: string; version: string; build: number; features?: string[] }
export const SHARED_PLAYER = 'player.shared';

export interface NativePlayer {
  // The app itself (ADR-0016): which platform, its version, and what it can do.
  info(): Promise<NativeInfo>;
  subscribe(session?: NativeSession): Promise<NativeState>;
  load(load: NativeLoad): Promise<NativeState>;
  // Refused with 'stale' when the songs changed since `revision`.
  setQueue(queue: Track[], revision: number): Promise<NativeState>;
  control(control: NativeControl): Promise<NativeState>;
  onState(listener: (state: NativeState) => void): void;
  onNotice(listener: (message: string, kind: 'error' | 'info' | 'success') => void): void;
}

export class NativeError extends Error {}

export function nativePlayer(port: Port | undefined = typeof window === 'undefined' ? undefined : window.vybatronNative): NativePlayer | null {
  if (!port) return null;
  let next = 1;
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const states = new Set<(state: NativeState) => void>();
  const notices = new Set<(message: string, kind: 'error' | 'info' | 'success') => void>();
  port.addEventListener('message', event => {
    let message: { id?: number; ok?: boolean; result?: unknown; error?: string; event?: string; state?: NativeState; message?: string; kind?: string };
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.event === 'player.state' && message.state) { for (const listener of states) listener(message.state); return; }
    if (message.event === 'player.notice' && typeof message.message === 'string') {
      const kind = message.kind === 'info' || message.kind === 'success' ? message.kind : 'error';
      for (const listener of notices) listener(message.message, kind);
      return;
    }
    const pending = typeof message.id === 'number' ? waiting.get(message.id) : undefined;
    if (!pending) return;
    waiting.delete(message.id!); clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result); else pending.reject(new NativeError(message.error || 'failed'));
  });
  const request = <T>(type: string, body: object = {}) => new Promise<T>((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new NativeError('timeout')); }, 10_000);
    waiting.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    port.postMessage(JSON.stringify({ ...body, id, type }));
  });
  let info: Promise<NativeInfo> | null = null;
  return {
    info: () => (info ??= request<NativeInfo>('app.info').catch(error => { info = null; throw error; })),
    subscribe: session => request<NativeState>('player.subscribe', session ? { session } : {}),
    load: load => request<NativeState>('player.load', load),
    setQueue: (queue, revision) => request<NativeState>('player.setQueue', { queue, revision }),
    control: control => request<NativeState>('player.control', control),
    onState: listener => { states.add(listener); },
    onNotice: listener => { notices.add(listener); },
  };
}
