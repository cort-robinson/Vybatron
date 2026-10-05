import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ArrowClockwiseIcon, MusicNotesIcon, UserIcon, XIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { publicUrl } from '../api';
import type { Track } from '../types';

export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}
export function Artwork({ track, className = '', large = false }: { track: Track | null; className?: string; large?: boolean }) {
  return <img className={`artwork ${className}`} src={publicUrl(track?.artworkUrl) || '/assets/fallback-cover.png'} alt={large && track ? `Artwork for ${track.title}` : ''}
    loading={large ? 'eager' : 'lazy'} decoding="async" onError={event => { if (!event.currentTarget.src.endsWith('/assets/fallback-cover.png')) event.currentTarget.src = '/assets/fallback-cover.png'; }} />;
}
export function Avatar({ url, name, className = '' }: { url?: string | null; name: string; className?: string }) {
  const src = publicUrl(url);
  return <span className={`avatar ${className}`} title={name}><UserIcon size={20} aria-hidden="true" />{src && <img src={src} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none'; }} />}</span>;
}
export function Empty({ title, description, action, icon }: { title: string; description: string; action?: ReactNode; icon?: ReactNode }) {
  return <div className="empty-state"><div className="empty-art"><img src="/assets/fallback-cover.png" alt="" />{icon || <MusicNotesIcon size={30} />}</div><h3>{title}</h3><p>{description}</p>{action}</div>;
}
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="inline-error" role="alert"><WarningCircleIcon size={24} /><div><strong>Couldn’t load this view</strong><p>{message}</p></div>{retry && <button className="button secondary" onClick={retry}><ArrowClockwiseIcon />Try again</button>}</div>;
}
export function Loading({ label = 'Getting your listening space…' }: { label?: string }) {
  return <div className="loading-state" role="status"><span className="spinner" /><span>{label}</span></div>;
}
export function Dialog({ title, children, onClose, className = '' }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current; if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={`dialog ${className}`} aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) { const b = event.currentTarget.getBoundingClientRect(); if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) onClose(); } }}>
    <div className="dialog-heading"><h2>{title}</h2><IconButton label="Close dialog" onClick={onClose}><XIcon size={23} /></IconButton></div>{children}
  </dialog>;
}
export function Confirm({ title, detail, action, onConfirm, onClose, busy = false }: { title: string; detail: string; action: string; onConfirm: () => void; onClose: () => void; busy?: boolean }) {
  return <Dialog title={title} onClose={onClose} className="confirm-dialog"><p>{detail}</p><div className="form-actions"><button className="button secondary" onClick={onClose}>Cancel</button><button className="button danger" disabled={busy} onClick={onConfirm}>{busy ? 'Working…' : action}</button></div></Dialog>;
}
