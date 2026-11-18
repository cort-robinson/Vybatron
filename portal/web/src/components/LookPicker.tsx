import { skinNames, type Skin } from '../skin';
import { CheckIcon } from '../icons';
import overdrive from '../assets/look-previews/look-preview-overdrive.webp';
import fantastic from '../assets/look-previews/look-preview-fantastic.webp';
import haunted from '../assets/look-previews/look-preview-haunted.webp';
import classic from '../assets/look-previews/look-preview-classic.webp';
import sleeveLight from '../assets/look-previews/look-preview-sleeve-light.webp';
import sleeveDark from '../assets/look-previews/look-preview-sleeve-dark.webp';
import broadcast from '../assets/look-previews/look-preview-broadcast.webp';
import wall from '../assets/look-previews/look-preview-wall.webp';
import './look-picker.css';

const previews: Record<Skin, { image: string; description: string }> = {
  overdrive: { image: overdrive, description: 'A synthwave look: neon sunset, city skyline and glowing controls.' },
  fantastic: { image: fantastic, description: 'A retro comic-book look: a ringed planet, a 1960s skyline and the cover on a vintage TV.' },
  haunted: { image: haunted, description: 'A Halloween look: a full moon, bare trees and jack-o’-lanterns, with the cover in a candlelit frame.' },
  'sleeve-light': { image: sleeveLight, description: 'Cream paper, burgundy type and full-color record sleeves.' },
  'sleeve-dark': { image: sleeveDark, description: 'Midnight plum, warm ivory type and full-color record sleeves.' },
  broadcast: { image: broadcast, description: 'An orange-lit control desk with the current song beside the queue on wide screens.' },
  wall: { image: wall, description: 'An artwork-led player with a filmstrip of upcoming songs on large screens.' },
  classic: { image: classic, description: 'The original look: calm smoked glass, lit by the cover’s colors.' },
};

export function LookPicker({ skin, setSkin }: { skin: Skin; setSkin: (value: Skin) => void }) {
  return <div className="look-picker" role="group" aria-labelledby="look-picker-title">
    <h3 id="look-picker-title">Portal look</h3>
    <div className="look-grid">{(Object.keys(skinNames) as Skin[]).map(value =>
      <button type="button" key={value} className="look-option" aria-pressed={skin === value}
        aria-description={previews[value].description} onClick={() => setSkin(value)}>
        <img src={previews[value].image} alt="" width="400" height="240" decoding="async" />
        <span className="look-name">{skinNames[value]}</span>
        {skin === value && <span className="look-check" aria-hidden="true"><CheckIcon size={15} weight="bold" /></span>}
      </button>
    )}</div>
    <p className="look-description">{previews[skin].description}</p>
  </div>;
}
