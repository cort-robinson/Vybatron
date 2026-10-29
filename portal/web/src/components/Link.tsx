import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { generate } from 'lean-qr';
import { ArrowClockwiseIcon, CheckCircleIcon, ShieldCheckIcon, WarningCircleIcon } from '../icons';
import { ApiError, api, errorMessage, type DeviceStart } from '../api';
import { completeCode, formatCode } from '../link';
import type { Portal } from '../usePortal';
import { Dialog, Loading } from './ui';

// A QR code drawn as one SVG path, generated here: no image, data URL or request leaves the page.
export function QrCode({ value, label }: { value: string; label: string }) {
  const { d, size } = useMemo(() => {
    const code = generate(value); const quiet = 4; let path = '';
    for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++) if (code.get(x, y)) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    return { d: path, size: code.size + quiet * 2 };
  }, [value]);
  return <svg className="qr-code" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
    <rect width={size} height={size} fill="#fff" /><path d={d} fill="#000" />
  </svg>;
}

type Showing = { kind: 'starting' } | { kind: 'showing'; start: DeviceStart } | { kind: 'ended'; message: string };
const retryable = (error: unknown) => error instanceof ApiError && (error.status === 0 || error.status === 429 || error.status >= 500);

// Signing in this screen with a code a signed-in listener approves on another device (ADR-0019).
// On a TV (`tv`) it is the first sign-in screen, sized to read from across the room.
export function CodeSignIn({ tv = false, onSignedIn, onCancel }: { tv?: boolean; onSignedIn: () => void; onCancel: () => void }) {
  const [state, setState] = useState<Showing>({ kind: 'starting' });
  const [attempt, setAttempt] = useState(0);
  const signedIn = useRef(onSignedIn); signedIn.current = onSignedIn;
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setState({ kind: 'starting' });
    void (async () => {
      let start: DeviceStart;
      try { start = await api.deviceStart(); }
      catch (error) { if (active) setState({ kind: 'ended', message: errorMessage(error) }); return; }
      if (!active) return;
      setState({ kind: 'showing', start });
      const wait = Math.max(1, start.interval) * 1000;
      const poll = async () => {
        try {
          const { status } = await api.devicePoll(controller.signal);
          if (!active) return;
          if (status === 'approved') { signedIn.current(); return; }
          if (status === 'denied') { setState({ kind: 'ended', message: 'That code was turned down. Get a new code to try again.' }); return; }
          if (status === 'expired') { setState({ kind: 'ended', message: 'That code expired. Get a new code to try again.' }); return; }
        } catch (error) {
          if (!active) return;
          // A dropped connection or a busy portal: keep waiting while the code lives.
          if (!retryable(error)) { setState({ kind: 'ended', message: errorMessage(error) }); return; }
        }
        timer = setTimeout(poll, wait);
      };
      timer = setTimeout(poll, wait);
    })();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [attempt]);
  const back = <button type="button" className="text-button code-signin-back" onClick={onCancel}>Sign in with Discord instead</button>;
  const className = tv ? 'code-signin tv' : 'code-signin';
  if (state.kind === 'starting') return <div className={className}><Loading label="Getting a code…" />{back}</div>;
  if (state.kind === 'ended') return <div className={className}><p role="alert">{state.message}</p>
    <button type="button" className="button primary" onClick={() => setAttempt(value => value + 1)}><ArrowClockwiseIcon size={20} />Get a new code</button>{back}</div>;
  const { userCode, verificationUri } = state.start;
  const address = verificationUri.replace(/^https?:\/\//, '');
  return <div className={className}>
    <p className="code-signin-where">On a phone or computer that’s signed in, go to <strong>{address}</strong> and enter this code:</p>
    <p className="device-code" aria-label={`Code ${userCode.split('').join(' ')}`}>{userCode}</p>
    <QrCode value={`${verificationUri}?code=${userCode}`} label={`QR code for ${address} with this code`} />
    <p className="signin-footnote" role="status"><span className="spinner" />Or scan the QR code. Waiting for approval…</p>
    {back}
  </div>;
}

// A signed-in listener approves, or turns down, a code shown on another screen.
export function LinkDialog({ portal, initialCode, onClose }: { portal: Portal; initialCode: string; onClose: () => void }) {
  const [code, setCode] = useState(() => formatCode(initialCode));
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [result, setResult] = useState<'approved' | 'denied' | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const name = portal.bootstrap?.viewer.displayName || 'you';
  const decide = async (action: 'approve' | 'deny') => {
    if (!completeCode(code)) { setError('Enter the 8-letter code shown on the screen.'); input.current?.focus(); return; }
    if (!portal.bootstrap) return;
    setBusy(action); setError('');
    try {
      await (action === 'approve' ? api.approveDevice : api.denyDevice)(portal.bootstrap.csrfToken, code);
      setResult(action === 'approve' ? 'approved' : 'denied');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(null); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void decide('approve'); };
  const close = <div className="form-actions"><button type="button" className="button primary" onClick={onClose}>Done</button></div>;
  if (result) return <Dialog title="Sign in another screen" onClose={onClose} className="confirm-dialog link-dialog">
    <p className="link-result" role="status">{result === 'approved' ? <><CheckCircleIcon size={22} aria-hidden="true" />The screen showing {code} is signing in as {name}. It continues on its own in a few seconds.</> : <>The screen showing {code} won’t be signed in.</>}</p>{close}
  </Dialog>;
  return <Dialog title="Sign in another screen" onClose={onClose} className="confirm-dialog link-dialog" initialFocusRef={input}>
    <form onSubmit={submit}>
      <p>Sign in the screen showing this code as <strong>{name}</strong>?</p>
      <label className="link-code"><span>Code</span><input ref={input} value={code} onChange={event => { setCode(formatCode(event.target.value)); setError(''); }}
        placeholder="XXXX-XXXX" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={9} aria-describedby="link-warning" /></label>
      <p className="link-warning" id="link-warning"><ShieldCheckIcon size={20} aria-hidden="true" /><span>Only approve a code shown on a screen in front of you. Anyone who gets you to approve their code can use Vybatron as you.</span></p>
      {error && <p className="notice-line warm-text link-error" role="alert"><WarningCircleIcon size={18} aria-hidden="true" />{error}</p>}
      <div className="form-actions">
        <button type="button" className="button secondary" disabled={!!busy} onClick={() => void decide('deny')}>{busy === 'deny' && <span className="spinner" />}Deny</button>
        <button type="submit" className="button primary" disabled={!!busy}>{busy === 'approve' && <span className="spinner" />}Approve</button>
      </div>
    </form>
  </Dialog>;
}
