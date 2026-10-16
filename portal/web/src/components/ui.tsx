import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type RefObject } from 'react';
import { ArrowClockwiseIcon, MusicNotesIcon, UserIcon, XIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { publicUrl } from '../api';
import type { Track } from '../types';

export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}
export function FallbackCover({ className = '', alt = '', large = false }: { className?: string; alt?: string; large?: boolean }) {
  const sizes = large ? '(max-width: 960px) calc(100vw - 40px), (max-width: 1100px) 45vw, 560px' : '180px';
  return <picture className={className}>
    <source type="image/webp" srcSet="/assets/fallback-cover-320.webp 320w, /assets/fallback-cover-640.webp 640w, /assets/fallback-cover-1024.webp 1024w" sizes={sizes} />
    <img src="/assets/fallback-cover-320.webp" alt={alt} width={320} height={320} loading={large ? 'eager' : 'lazy'} decoding="async"
      style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }} />
  </picture>;
}
// A changed cover keeps the previous image on screen until the next one has decoded, so a song
// change never shows an empty frame between covers.
function useDecodedSource(source: string | undefined) {
  const [shown, setShown] = useState(source);
  useEffect(() => {
    if (source === shown) return;
    if (!source || !shown) { setShown(source); return; }
    let current = true; const image = new Image(); image.src = source;
    void image.decode().catch(() => undefined).then(() => { if (current) setShown(source); });
    return () => { current = false; };
  }, [source, shown]);
  return shown;
}
export function Artwork({ track, className = '', large = false }: { track: Track | null; className?: string; large?: boolean }) {
  const source = useDecodedSource(publicUrl(track?.artworkUrl));
  const [failedSource, setFailedSource] = useState<string | undefined>();
  // A large cover dissolves into the next: the previous image lingers on top and fades out.
  const [ghost, setGhost] = useState<string>();
  const previous = useRef(source);
  useEffect(() => {
    if (large && previous.current && source && previous.current !== source) setGhost(previous.current);
    previous.current = source;
  }, [source, large]);
  const alt = large && track ? `Artwork for ${track.title}` : '';
  // No current song: an honest empty sleeve rather than a photo that reads as a track.
  if (!track) return <span className={`artwork artwork-empty ${className}`}><MusicNotesIcon size={large ? 56 : 24} aria-hidden="true" /></span>;
  if (!source || source === failedSource) return <FallbackCover className={`artwork ${className}`} alt={alt} large={large} />;
  return <><img className={`artwork ${className}`} src={source} alt={alt}
    loading={large ? 'eager' : 'lazy'} decoding="async" onError={() => setFailedSource(source)} />
    {ghost && <img key={ghost} className="artwork-ghost" src={ghost} alt="" aria-hidden="true" onAnimationEnd={() => setGhost(undefined)} />}</>;
}
export function Avatar({ url, name, className = '' }: { url?: string | null; name: string; className?: string }) {
  const src = publicUrl(url);
  return <span className={`avatar ${className}`} title={name}><UserIcon size={20} aria-hidden="true" />{src && <img src={src} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none'; }} />}</span>;
}
export function Empty({ title, description, action, icon }: { title: string; description: string; action?: ReactNode; icon?: ReactNode }) {
  return <div className="empty-state"><div className="empty-art">{icon || <MusicNotesIcon size={30} />}</div><h2>{title}</h2><p>{description}</p>{action}</div>;
}
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="inline-error" role="alert"><WarningCircleIcon size={24} /><div><strong>Couldn’t load this view</strong><p>{message}</p></div>{retry && <button className="button secondary" onClick={retry}><ArrowClockwiseIcon />Try again</button>}</div>;
}
export function Loading({ label = 'Getting your listening space…' }: { label?: string }) {
  return <div className="loading-state" role="status"><span className="spinner" /><span>{label}</span></div>;
}
const focusableSelector = 'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
function focusableElements(container: ParentNode) {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(element => element.tabIndex >= 0 && !element.closest('[inert], [hidden]') && element.getClientRects().length > 0);
}

// The popover supplies .menu-panel; children supply its actions and explanatory content.
export function ActionPopover({ label, trigger, className = '', triggerClassName = 'icon-button', panelClassName = '', children }: {
  label: string; trigger: ReactNode; className?: string; triggerClassName?: string; panelClassName?: string; children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { setOpen(false); button.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const content = panel.current;
    if (content) (focusableElements(content)[0] || content).focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || wrapper.current?.contains(event.target)) return;
      setOpen(false);
      // Let an outside control receive its normal pointer focus. Noninteractive
      // content needs a useful focus destination when the panel disappears.
      if (!(event.target instanceof Element) || !event.target.closest(focusableSelector)) {
        requestAnimationFrame(() => {
          const active = document.activeElement;
          if (!active || active === document.body || !active.matches(focusableSelector)) button.current?.focus({ preventScroll: true });
        });
      }
    };
    const focusOutside = (event: FocusEvent) => {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab' || !panel.current?.contains(document.activeElement)) return;
      const actions = focusableElements(panel.current);
      const first = actions[0]; const last = actions[actions.length - 1];
      if (event.shiftKey && (!first || document.activeElement === first)) { event.preventDefault(); close(); }
      else if (!event.shiftKey && (!last || document.activeElement === last)) {
        event.preventDefault();
        const order = focusableElements(document).filter(element => !panel.current?.contains(element));
        const next = order[order.indexOf(button.current!) + 1] || order[0] || button.current;
        setOpen(false); next?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', focusOutside);
    document.addEventListener('keydown', keyboard);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', focusOutside);
      document.removeEventListener('keydown', keyboard);
    };
  }, [open, close]);
  return <div ref={wrapper} className={`action-popover ${className}`}>
    <button ref={button} type="button" className={triggerClassName} aria-label={label} title={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{trigger}</button>
    {open && <div ref={panel} id={id} className={`menu-panel ${panelClassName}`} tabIndex={-1}>{children(close)}</div>}
  </div>;
}

export function Dialog({ title, children, onClose, className = '', initialFocusRef }: { title: string; children: ReactNode; onClose: () => void; className?: string; initialFocusRef?: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current; if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    initialFocusRef?.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (previous?.isConnected && !previous.closest('[inert], [hidden]') && previous.getClientRects().length) previous.focus({ preventScroll: true });
    };
  }, [initialFocusRef]);
  return <dialog ref={ref} className={`dialog ${className}`} aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      else if (event.key === 'Tab') {
        const actions = focusableElements(event.currentTarget);
        const first = actions[0]; const last = actions[actions.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}
    onClick={event => { if (event.target === event.currentTarget) { const b = event.currentTarget.getBoundingClientRect(); if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) onClose(); } }}>
    <div className="dialog-heading"><h2>{title}</h2><IconButton label="Close dialog" onClick={onClose}><XIcon size={23} /></IconButton></div>{children}
  </dialog>;
}
export function Confirm({ title, detail, action, onConfirm, onClose, busy = false }: { title: string; detail: string; action: string; onConfirm: () => void; onClose: () => void; busy?: boolean }) {
  return <Dialog title={title} onClose={onClose} className="confirm-dialog"><p>{detail}</p><div className="form-actions"><button className="button secondary" onClick={onClose}>Cancel</button><button className="button danger" disabled={busy} onClick={onConfirm}>{busy ? 'Working…' : action}</button></div></Dialog>;
}
