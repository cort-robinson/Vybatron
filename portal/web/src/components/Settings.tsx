import { useState } from 'react';
import { DiscordLogoIcon, DownloadSimpleIcon } from '../icons';
import { api, errorMessage } from '../api';
import type { Portal } from '../usePortal';
import type { Skin } from '../skin';
import { FRAME_RATES, chooseFrameRate, useFrameRate, type FrameRate } from '../visualizer/frameRate';

export type AmbientMode = 'on' | 'subtle' | 'off';
export interface InstallPrompt extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }

const lookDescription: Record<Skin, string> = {
  overdrive: 'A synthwave look: neon sunset, city skyline and glowing controls.',
  fantastic: 'A retro comic-book look: a ringed planet, a 1960s skyline and the cover on a vintage TV.',
  haunted: 'A Halloween look: a full moon, bare trees and jack-o’-lanterns, with the cover in a candlelit frame.',
  classic: 'The original look: calm smoked glass, lit by the cover’s colors.',
};

// Your own settings: how the portal looks and runs on this device, and your account. The server's
// shared listening defaults stay on the Server page.
export function SettingsView({ portal, active, ambient, setAmbient, skin, setSkin, performance, setPerformance, installPrompt, install }: { portal: Portal; active: boolean; ambient: AmbientMode; setAmbient: (value: AmbientMode) => void; skin: Skin; setSkin: (value: Skin) => void; performance: boolean; setPerformance: (value: boolean) => void; installPrompt: InstallPrompt | null; install: () => void }) {
  return <div className="settings-view" hidden={!active}>
    <section className="personal-settings" aria-labelledby="settings-look"><div className="section-heading"><div><h2 id="settings-look">Look and feel</h2><p className="section-description">These choices apply to this device.</p></div></div><div className="settings-list">
      <div className="setting-row"><div><label htmlFor="portal-look">Portal look</label><p>{lookDescription[skin]}</p></div><select id="portal-look" value={skin} onChange={event => setSkin(event.target.value as Skin)}><option value="overdrive">Overdrive</option><option value="fantastic">Fantastic Four</option><option value="haunted">Haunted</option><option value="classic">Classic</option></select></div>
      <div className="setting-row"><div><label htmlFor="ambient-mode">Ambient motion</label><p>{performance ? 'Paused while Performance mode is on; your choice returns when you turn it off.' : 'Lighting from the cover’s colors and the moving spectrum. Both rest while paused.'}</p></div><select id="ambient-mode" value={ambient} onChange={event => setAmbient(event.target.value as AmbientMode)}><option value="on">Immersive</option><option value="subtle">Subtle</option><option value="off">Off</option></select></div>
      <div className="setting-row"><div><h3>Performance mode</h3><p>{performance ? 'On: simpler panels and a still scene. Playback is unchanged.' : 'Simpler panels and a still background, for a smoother portal and longer battery.'}</p></div><button role="switch" aria-checked={performance} className="switch" aria-label="Performance mode" onClick={() => setPerformance(!performance)}><span />{performance ? 'On' : 'Off'}</button></div>
      <FrameRateSetting />
      {installPrompt && <div className="setting-row"><div><h3>Install the app</h3><p>Open Vybatron in its own window, like an app.</p></div><button className="button secondary" onClick={install}><DownloadSimpleIcon size={19} />Install app</button></div>}
    </div></section>
    <section className="personal-settings" aria-labelledby="settings-account"><h2 id="settings-account">Account</h2><div className="settings-list">
      {portal.bootstrap?.inviteUrl && <div className="setting-row"><div><h3>Add to another server</h3><p>Pick any server where you have Manage Server permission. Discord shows what Vybatron can access before you confirm.</p></div><a className="button secondary setting-link" href={portal.bootstrap.inviteUrl} target="_blank" rel="noopener noreferrer"><DiscordLogoIcon size={19} weight="fill" />Add to server</a></div>}
      <AutoplayTaste portal={portal} />
      <div className="setting-row"><div><h3>This device’s session</h3><p>Discord sign-in lasts up to seven days per device.</p></div><button className="text-button" onClick={() => void portal.logout()}>Sign out</button></div>
    </div></section>
    {!installPrompt && <p className="settings-footnote">To install Vybatron as an app, use your browser’s Install app or Add to Home Screen option.</p>}
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

function FrameRateSetting() {
  const rate = useFrameRate();
  return <div className="setting-row"><div><label htmlFor="visualizer-frame-rate">Visualizer frame rate</label><p id="visualizer-frame-rate-description">{rate === 'native' ? 'As often as your display refreshes, which may be 120 times a second or more. The smoothest motion, and the most battery.' : 'Higher is smoother; lower saves battery.'}</p></div><select id="visualizer-frame-rate" aria-describedby="visualizer-frame-rate-description" value={rate} onChange={event => chooseFrameRate(event.target.value === 'native' ? 'native' : Number(event.target.value) as FrameRate)}>{FRAME_RATES.map(option => <option key={option} value={option}>{option === 'native' ? 'Native' : `${option} fps`}</option>)}</select></div>;
}
