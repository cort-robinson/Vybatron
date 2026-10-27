import { useState } from 'react';
import { DiscordLogoIcon, DownloadSimpleIcon } from '../icons';
import { api, errorMessage } from '../api';
import type { Portal } from '../usePortal';
import type { Skin } from '../skin';

export type AmbientMode = 'on' | 'subtle' | 'off';
export interface InstallPrompt extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }

const lookDescription: Record<Skin, string> = {
  overdrive: 'A neon horizon, chrome wordmark, HUD-framed panels and a reactor-ring play button. Classic restores the original receiver.',
  fantastic: 'Earth-828, 1964: a ringed planet over a Googie skyline, Kirby krackle in the sky, and the cover playing on a vintage TV set. Flame on.',
  classic: 'The original smoked-glass receiver. Overdrive adds a neon horizon; Fantastic Four tunes in a retro-future broadcast.',
};

// Your own settings: how the portal looks and runs on this device, and your account. The server's
// shared listening defaults stay on the Server page.
export function SettingsView({ portal, active, ambient, setAmbient, skin, setSkin, performance, setPerformance, installPrompt, install }: { portal: Portal; active: boolean; ambient: AmbientMode; setAmbient: (value: AmbientMode) => void; skin: Skin; setSkin: (value: Skin) => void; performance: boolean; setPerformance: (value: boolean) => void; installPrompt: InstallPrompt | null; install: () => void }) {
  return <div className="settings-view" hidden={!active}>
    <section className="personal-settings" aria-labelledby="settings-look"><div className="section-heading"><div><h2 id="settings-look">Look and feel</h2><p className="section-description">These choices apply to this device.</p></div></div><div className="settings-list">
      <div className="setting-row"><div><label htmlFor="portal-look">Portal look</label><p>{lookDescription[skin]}</p></div><select id="portal-look" value={skin} onChange={event => setSkin(event.target.value as Skin)}><option value="overdrive">Overdrive</option><option value="fantastic">Fantastic Four</option><option value="classic">Classic</option></select></div>
      <div className="setting-row"><div><label htmlFor="ambient-mode">Ambient motion</label><p>Album-colored lighting and the decorative spectrum display. Both settle on pause and respect reduced motion.</p></div><select id="ambient-mode" value={ambient} onChange={event => setAmbient(event.target.value as AmbientMode)}><option value="on">Immersive</option><option value="subtle">Subtle</option><option value="off">Off</option></select></div>
      <div className="setting-row"><div><h3>Performance mode</h3><p>{performance ? 'Lighter rendering is on: solid panels instead of glass blur, no blurred cover light, and a still scene and spectrum. Controls and playback are unchanged.' : 'Full effects: glass blur, cover-colored light, and a moving scene. Turn this on if the portal feels slow or drains battery.'}</p></div><button role="switch" aria-checked={performance} className="switch" aria-label="Performance mode" onClick={() => setPerformance(!performance)}><span />{performance ? 'On' : 'Off'}</button></div>
      <div className="setting-row"><div><h3>Install the app</h3><p>{installPrompt ? 'Open Vybatron in its own window, like an app.' : 'Use your browser’s Install app or Add to Home Screen option when available.'}</p></div><button className="button secondary" disabled={!installPrompt} onClick={install}><DownloadSimpleIcon size={19} />Install app</button></div>
    </div></section>
    <section className="personal-settings" aria-labelledby="settings-account"><h2 id="settings-account">Account</h2><div className="settings-list">
      {portal.bootstrap?.inviteUrl && <div className="setting-row"><div><h3>Add to another server</h3><p>Pick any server where you have Manage Server permission. Discord shows what Vybatron can access before you confirm.</p></div><a className="button secondary" href={portal.bootstrap.inviteUrl} target="_blank" rel="noopener noreferrer"><DiscordLogoIcon size={19} weight="fill" />Add to server</a></div>}
      <AutoplayTaste portal={portal} />
      <div className="setting-row"><div><h3>This device’s session</h3><p>Discord sign-in lasts up to seven days per device.</p></div><button className="text-button" onClick={() => void portal.logout()}>Sign out</button></div>
    </div></section>
  </div>;
}

// Account-wide: applies in every server and on every device (ADR-0012).
function AutoplayTaste({ portal }: { portal: Portal }) {
  const { bootstrap, notify } = portal;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const stored = bootstrap?.viewer.autoplayTaste;
  if (!bootstrap || stored === undefined) return null;
  const value = enabled ?? stored;
  const toggle = () => {
    setSaving(true);
    void api.setAutoplayTaste(bootstrap.csrfToken, !value).then(setEnabled)
      .catch(failure => notify(errorMessage(failure), 'error')).finally(() => setSaving(false));
  };
  return <div className="setting-row"><div><h3>Autoplay uses my taste</h3><p>{value
    ? 'While you’re in voice with Vybatron, autoplay takes turns between everyone listening and picks some songs from what you request and favorite. Others in the channel may notice your picks.'
    : 'Autoplay won’t draw on your requests or favorites. It still follows what the room is playing.'} Applies in every server.</p></div>
    <button role="switch" aria-checked={value} className="switch" aria-label="Autoplay uses my taste" disabled={saving} onClick={toggle}><span />{value ? 'On' : 'Off'}</button></div>;
}
