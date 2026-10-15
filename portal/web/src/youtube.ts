// The official YouTube embed is the only way this browser plays audio, and only
// when the listener chooses "This device". Nothing here talks to the bot.
export interface YouTubePlayer {
  loadVideoById(options: { videoId: string; startSeconds?: number }): void;
  cueVideoById(options: { videoId: string; startSeconds?: number }): void;
  playVideo(): void; pauseVideo(): void; stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volume: number): void;
  getCurrentTime(): number; getDuration(): number; getPlayerState(): number;
  getVideoData?(): { video_id?: string };
  destroy(): void;
}
export interface YouTubeEvent { data: number; target: YouTubePlayer }
interface YouTubeApi {
  Player: new (frame: HTMLIFrameElement, options: { events: Record<'onReady' | 'onStateChange' | 'onError', (event: YouTubeEvent) => void> }) => YouTubePlayer;
}
declare global { interface Window { YT?: YouTubeApi; onYouTubeIframeAPIReady?: () => void } }

export const STATE = { unstarted: -1, ended: 0, playing: 1, paused: 2, buffering: 3, cued: 5 } as const;
// Embedding refused by the owner, removed, private, or region-blocked.
export const unplayableMessage = (code: number) => code === 2 ? 'This video link is invalid.'
  : code === 5 ? 'This video can’t play in the browser player.' : 'The owner doesn’t allow this video to play outside YouTube.';

let api: Promise<YouTubeApi> | null = null;
export function loadYouTube(): Promise<YouTubeApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  api ??= new Promise<YouTubeApi>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { previous?.(); resolve(window.YT!); };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api'; script.async = true;
    script.onerror = () => { api = null; script.remove(); reject(new Error('The YouTube player could not load. Check your connection or content blocker, then try again.')); };
    document.head.append(script);
  });
  return api;
}

// The portal sends no referrer by default; YouTube refuses embeds without one,
// so this frame alone sends the portal origin.
export function createFrame(): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  const params = new URLSearchParams({ enablejsapi: '1', origin: location.origin, playsinline: '1', rel: '0' });
  frame.src = `https://www.youtube-nocookie.com/embed/?${params}`;
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.allow = 'autoplay; encrypted-media; picture-in-picture';
  frame.title = 'YouTube player';
  return frame;
}

export function youtubeId(uri: string | null | undefined): string | null {
  if (!uri) return null;
  try {
    const url = new URL(uri);
    const host = url.hostname.replace(/^(www|m|music)\./, '');
    const id = host === 'youtube.com' && url.pathname === '/watch' ? url.searchParams.get('v') : host === 'youtu.be' ? url.pathname.slice(1) : null;
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}
