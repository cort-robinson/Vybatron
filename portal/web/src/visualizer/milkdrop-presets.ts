// The MilkDrop presets the portal plays (milkdrop.ts), from butterchurn-presets: only these are
// bundled. Each was chosen for looking good on a small, stretched drawing buffer and for its cost:
// rendered in a software GPU at 480x270, none takes more than about two and a half times the
// cheapest, which rules out the packs' heavy multi-pass shaders, big blur chains and presets with
// hundreds of shape instances. Some long names are shortened for the screen.
import type { Preset } from 'butterchurn';
import cauldronPainterly2SaturationRemix from 'butterchurn-presets/presets/converted/Geiss - Cauldron - painterly 2 (saturation remix).json';
import spiralMovement from 'butterchurn-presets/presets/converted/Krash + Illusion - Spiral Movement.json';
import explosiveMinds from 'butterchurn-presets/presets/converted/Rovastar - Explosive Minds.json';
import balkAcid from 'butterchurn-presets/presets/converted/Rovastar & Idiot24-7 - Balk Acid.json';
import disorientingNebula from 'butterchurn-presets/presets/converted/phat + Eo.S. - Bass_responce_Red_Movements_Disorienting nebula3.json';
import songflowerMossPosy from 'butterchurn-presets/presets/converted/Aderrasi - Songflower (Moss Posy).json';
import asylumAnimations from 'butterchurn-presets/presets/converted/Rovastar + Che - Asylum Animations.json';
import ultramix243 from 'butterchurn-presets/presets/converted/bdrv - ultramix2 #43.json';
import rewop from 'butterchurn-presets/presets/converted/Unchained - Rewop.json';
import hallsOfCentrifuge from 'butterchurn-presets/presets/converted/Aderrasi - Halls Of Centrifuge.json';
import contortionWideTwistMix from 'butterchurn-presets/presets/converted/Aderrasi - Contortion (Wide Twist Mix).json';
import oozingResistance from 'butterchurn-presets/presets/converted/Rovastar - Oozing Resistance.json';
import makingAScienceOfIt7 from 'butterchurn-presets/presets/converted/Unchained - Making a Science of It 7.json';
import airhandlerPainterlyTendrils from 'butterchurn-presets/presets/converted/Aderrasi + Geiss - Airhandler (Kali Mix) - Painterly Tendrils Colorfast.json';
import skylightStainedGlassMajestyMix from 'butterchurn-presets/presets/converted/Eo.S. + Zylot - skylight (Stained Glass Majesty mix).json';
import veilOfSteelSteelStorm from 'butterchurn-presets/presets/converted/Aderrasi - Veil of Steel (Steel Storm) - mash0000 - bob ross finally loses it.json';
import wormholePillarsHallOfShadowsMix from 'butterchurn-presets/presets/converted/Unchained & Rovastar - Wormhole Pillars (Hall of Shadows mix).json';
import unifiedDrag2 from 'butterchurn-presets/presets/converted/Unchained - Unified Drag 2.json';
import airhandlerLastBreathCalm from 'butterchurn-presets/presets/converted/Aderrasi - Airhandler (Last Breath - Calm).json';
import glowsticksV205AndProtonLights from 'butterchurn-presets/presets/converted/Eo.S. - glowsticks v2 05 and proton lights (+Krash′s beat code) _Phat_remix07 recursive demons.json';
import makingAScienceOfIt4 from 'butterchurn-presets/presets/converted/Unchained - Making a Science of It 4.json';
import potionOfSpirits from 'butterchurn-presets/presets/converted/Aderrasi - Potion of Spirits.json';
import desertRose4 from 'butterchurn-presets/presets/converted/Geiss - Desert Rose 4.json';
import altarsOfMadnessRollingOceansMix from 'butterchurn-presets/presets/converted/Rovastar + Telek - Altars of Madness (Rolling Oceans Mix).json';
import trueVisionaryFinalMix from 'butterchurn-presets/presets/converted/Zylot - True Visionary (Final Mix).json';
import liquidArrows from 'butterchurn-presets/presets/converted/Martin - liquid arrows.json';
import p049 from 'butterchurn-presets/presets/converted/_Mig_049.json';
import passageMandalaMix from 'butterchurn-presets/presets/converted/Cope - Passage (mandala mix).json';
import swingOutOnTheSpiral from 'butterchurn-presets/presets/converted/flexi - swing out on the spiral.json';
import colorful9 from 'butterchurn-presets/presets/converted/_Mig_COLORFUL9.json';
import glowsticksV202GeissHpf from 'butterchurn-presets/presets/converted/_Eo.S. - glowsticks v2 02 - Geiss HPF.json';
import reactionDiffusion2 from 'butterchurn-presets/presets/converted/Geiss - Reaction Diffusion 2.json';
import stormOfTheEyeThunder from 'butterchurn-presets/presets/converted/Aderrasi - Storm of the Eye (Thunder) - mash0000 - quasi pseudo meta concentrics.json';
import mashup220 from 'butterchurn-presets/presets/converted/$$$ Royal - Mashup (220).json';
import snapshotOfSpaceLsbMix from 'butterchurn-presets/presets/converted/Rovastar + Geiss - Snapshot Of Space (LSB mix).json';
import fruitMachine from 'butterchurn-presets/presets/converted/martin - fruit machine.json';
import theDrainToHeaven from 'butterchurn-presets/presets/converted/cope - the drain to heaven.json';
import discoMix6 from 'butterchurn-presets/presets/converted/Martin - disco mix 6.json';
import fataMorgana from 'butterchurn-presets/presets/converted/martin [shadow harlequins shape code] - fata morgana.json';
import magmaPool from 'butterchurn-presets/presets/converted/ORB - Magma Pool.json';

export const MILKDROP: readonly { name: string; preset: Preset }[] = [
  { name: 'Geiss - Cauldron - painterly 2 (saturation remix)', preset: cauldronPainterly2SaturationRemix },
  { name: 'Krash + Illusion - Spiral Movement', preset: spiralMovement },
  { name: 'Rovastar - Explosive Minds', preset: explosiveMinds },
  { name: 'Rovastar & Idiot24-7 - Balk Acid', preset: balkAcid },
  { name: 'phat + Eo.S. - Disorienting Nebula', preset: disorientingNebula },
  { name: 'Aderrasi - Songflower (Moss Posy)', preset: songflowerMossPosy },
  { name: 'Rovastar + Che - Asylum Animations', preset: asylumAnimations },
  { name: 'bdrv - ultramix2 #43', preset: ultramix243 },
  { name: 'Unchained - Rewop', preset: rewop },
  { name: 'Aderrasi - Halls Of Centrifuge', preset: hallsOfCentrifuge },
  { name: 'Aderrasi - Contortion (Wide Twist Mix)', preset: contortionWideTwistMix },
  { name: 'Rovastar - Oozing Resistance', preset: oozingResistance },
  { name: 'Unchained - Making a Science of It 7', preset: makingAScienceOfIt7 },
  { name: 'Aderrasi + Geiss - Airhandler (Painterly Tendrils)', preset: airhandlerPainterlyTendrils },
  { name: 'Eo.S. + Zylot - skylight (Stained Glass Majesty mix)', preset: skylightStainedGlassMajestyMix },
  { name: 'Aderrasi - Veil of Steel (Steel Storm)', preset: veilOfSteelSteelStorm },
  { name: 'Unchained & Rovastar - Wormhole Pillars (Hall of Shadows mix)', preset: wormholePillarsHallOfShadowsMix },
  { name: 'Unchained - Unified Drag 2', preset: unifiedDrag2 },
  { name: 'Aderrasi - Airhandler (Last Breath - Calm)', preset: airhandlerLastBreathCalm },
  { name: 'Eo.S. - Glowsticks v2 05 and Proton Lights', preset: glowsticksV205AndProtonLights },
  { name: 'Unchained - Making a Science of It 4', preset: makingAScienceOfIt4 },
  { name: 'Aderrasi - Potion of Spirits', preset: potionOfSpirits },
  { name: 'Geiss - Desert Rose 4', preset: desertRose4 },
  { name: 'Rovastar + Telek - Altars of Madness (Rolling Oceans Mix)', preset: altarsOfMadnessRollingOceansMix },
  { name: 'Zylot - True Visionary (Final Mix)', preset: trueVisionaryFinalMix },
  { name: 'Martin - liquid arrows', preset: liquidArrows },
  { name: 'Mig - 049', preset: p049 },
  { name: 'Cope - Passage (mandala mix)', preset: passageMandalaMix },
  { name: 'flexi - swing out on the spiral', preset: swingOutOnTheSpiral },
  { name: 'Mig - Colorful 9', preset: colorful9 },
  { name: 'Eo.S. - Glowsticks v2 02 (Geiss HPF)', preset: glowsticksV202GeissHpf },
  { name: 'Geiss - Reaction Diffusion 2', preset: reactionDiffusion2 },
  { name: 'Aderrasi - Storm of the Eye (Thunder)', preset: stormOfTheEyeThunder },
  { name: 'Royal - Mashup (220)', preset: mashup220 },
  { name: 'Rovastar + Geiss - Snapshot Of Space (LSB mix)', preset: snapshotOfSpaceLsbMix },
  { name: 'martin - fruit machine', preset: fruitMachine },
  { name: 'cope - the drain to heaven', preset: theDrainToHeaven },
  { name: 'Martin - disco mix 6', preset: discoMix6 },
  { name: 'martin - fata morgana', preset: fataMorgana },
  { name: 'ORB - Magma Pool', preset: magmaPool },
];
