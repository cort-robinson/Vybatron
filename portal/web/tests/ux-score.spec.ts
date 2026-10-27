import { test, expect, cssScene, type Page } from './test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { mockPortal } from './fixtures';

// UX hill-climb scorer. Not part of CI: run with `UX_LABEL=<name> npx playwright test ux-score`.
// Each screen and scroll position is measured on the rendered page and scored out of 100; every
// finding is boxed on an annotated screenshot in .impeccable/score/<label>/.
test.skip(!process.env.UX_LABEL, 'UX scoring runs on demand.');

const viewports = [{ name: 'desktop', width: 1488, height: 1056, density: 1, target: 24 }, { name: 'phone', width: 393, height: 852, density: 2, target: 44 }];
const screens = ['home', 'search', 'session', 'music', 'server', 'settings', 'player'] as const;
// Reaches a screen by whatever route this build offers; a screen the build lacks is skipped.
async function open(page: Page, screen: typeof screens[number]) {
  const button = (name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' }).filter({ visible: true });
  const tap = async (...names: string[]) => { for (const name of names) if (await button(name).count()) { await button(name).first().click(); return true; } return false; };
  if (screen === 'player') return tap('Open player');
  if (screen === 'home') return tap('Home');
  if (screen === 'search') return tap('Search');
  if (screen === 'session') return tap('Queue', 'Session');
  if (screen === 'music') return tap('My Music');
  if (screen === 'server') { if (await tap('Server')) return true; if (!(await tap('Account options'))) return false; return tap('Server'); }
  if (await tap('Open settings')) return (await page.getByRole('heading', { name: 'Settings', level: 1 }).count()) > 0;
  if (!(await tap('Account options'))) return false; return tap('Settings');
}
// Deduction per finding, and the most a check can deduct from one capture.
export const weights = {
  contrast: { each: 6, cap: 30, label: 'Text below WCAG contrast on the pixels behind it' },
  scenery: { each: 3, cap: 15, label: 'Text left over the skyline when the page can scroll no further' },
  target: { each: 3, cap: 15, label: 'Control smaller than the touch/pointer target' },
  clipped: { each: 4, cap: 12, label: 'Text or control cut off' },
  tiny: { each: 2, cap: 8, label: 'Text smaller than 12px' },
  emptiness: { each: 1, cap: 6, label: 'Empty first screen (per 5% of the content area unused beyond 40%)' },
  heading: { each: 6, cap: 6, label: 'Page has no visible heading' },
  axe: { each: 5, cap: 20, label: 'axe WCAG A/AA violation' },
};
type Kind = keyof typeof weights;
type Finding = { kind: Kind; box: { x: number; y: number; w: number; h: number }; note: string };
const settle = () => document.fonts.ready.then(() => Promise.all(Array.from(document.images).filter(image => image.getBoundingClientRect().width > 0).map(image => { image.loading = 'eager'; return image.decode().catch(() => {}); })));

// Text runs, controls, clipping and coverage, measured in the page.
function inspect([minTarget, final]: [number, boolean]) {
  const out: { text: { x: number; y: number; w: number; h: number; color: string; alpha: number; large: boolean; size: number; label: string }[]; findings: Finding[]; coverage: number; heading: boolean } = { text: [], findings: [], coverage: 0, heading: false };
  const vw = innerWidth, vh = innerHeight;
  const visible = (el: Element) => { for (let node: Element | null = el; node; node = node.parentElement) { const s = getComputedStyle(node); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0 || node.hasAttribute('hidden')) return false; if (node.classList.contains('ambient-scene') || node.classList.contains('sr-only')) return false; } return true; };
  const opacity = (el: Element) => { let o = 1; for (let node: Element | null = el; node; node = node.parentElement) o *= Number(getComputedStyle(node).opacity); return o; };
  const onScreen = (r: DOMRect) => r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  const box = (r: DOMRect) => ({ x: Math.max(0, r.left), y: Math.max(0, r.top), w: Math.min(vw, r.right) - Math.max(0, r.left), h: Math.min(vh, r.bottom) - Math.max(0, r.top) });
  const name = (el: Element) => (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
  // Whatever paints on top at a point; text under the player bar or a sheet isn't "visible text".
  const topmost = (el: Element, r: DOMRect) => { const hit = document.elementFromPoint(Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), Math.min(vh - 1, Math.max(0, r.top + r.height / 2))); return !!hit && (el.contains(hit) || hit.contains(el)); };
  const skyline = document.querySelector('.od-skyline-near')?.closest('svg')?.getBoundingClientRect();
  // Computed colours may be oklab()/color-mix(); the canvas resolves any of them to sRGB.
  const ink = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  const rgba = (color: string) => { ink.clearRect(0, 0, 1, 1); ink.fillStyle = '#000'; ink.fillStyle = color; ink.fillRect(0, 0, 1, 1); const [r, g, b, a] = ink.getImageData(0, 0, 1, 1).data; return `rgba(${r}, ${g}, ${b}, ${a / 255})`; };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const covered: DOMRect[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement; if (!el || !node.textContent?.trim() || !visible(el)) continue;
    const disabled = !!el.closest(':disabled, [aria-disabled="true"]');
    const own = el.getBoundingClientRect(); if (own.width < 3 || own.height < 3) continue; // visually hidden labels
    const range = document.createRange(); range.selectNodeContents(node);
    for (const r of Array.from(range.getClientRects())) {
      if (!onScreen(r) || r.width < 3 || r.height < 3 || !topmost(el, r)) continue;
      const s = getComputedStyle(el); const size = parseFloat(s.fontSize); const bold = Number(s.fontWeight) >= 700;
      if (!disabled) out.text.push({ ...box(r), color: rgba(s.color), alpha: opacity(el), large: size >= 24 || (bold && size >= 18.66), size, label: node.textContent.trim().slice(0, 40) });
      if (size < 12) out.findings.push({ kind: 'tiny', box: box(r), note: `${size}px “${node.textContent.trim().slice(0, 24)}”` });
      if (final && skyline && r.bottom > skyline.top + skyline.height * .25 && r.top < skyline.bottom && !el.closest('.player-footer, .bottom-nav, .mobile-tabs, nav, [data-glass]')) out.findings.push({ kind: 'scenery', box: box(r), note: `“${node.textContent.trim().slice(0, 24)}”` });
      covered.push(r);
    }
  }
  // Every eligible control first, so the spacing exception doesn't depend on DOM order.
  const controls = Array.from(new Set(document.querySelectorAll('button, a[href], input, select, textarea, [role="tab"], [role="slider"], [role="button"]'))).filter(el => { const r = el.getBoundingClientRect(); return onScreen(r) && visible(el) && topmost(el, r); });
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    covered.push(r);
    // WCAG 2.5.8: an undersized target passes if a 24px circle on its centre clears every other target.
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const spacing = controls.every(other => { if (other === el || other.contains(el) || el.contains(other)) return true; const o = other.getBoundingClientRect(); const dx = Math.max(o.left - cx, 0, cx - o.right), dy = Math.max(o.top - cy, 0, cy - o.bottom); return Math.hypot(dx, dy) >= minTarget / 2; });
    if ((r.width < minTarget - .5 || r.height < minTarget - .5) && !(minTarget === 24 && spacing) && el.tagName !== 'A') out.findings.push({ kind: 'target', box: box(r), note: `${Math.round(r.width)}×${Math.round(r.height)} ${name(el)}` });
    const faded = (() => { for (let node = el.parentElement; node; node = node.parentElement) { const s = getComputedStyle(node); if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && s.maskImage !== 'none') return true; } return false; })();
    if ((r.left < -1 || r.right > vw + 1) && !faded) out.findings.push({ kind: 'clipped', box: box(r), note: `off screen: ${name(el)}` });
  }
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (!visible(el) || !el.childNodes.length) continue; const s = getComputedStyle(el); const r = el.getBoundingClientRect(); if (!onScreen(r)) continue;
    if (s.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) out.findings.push({ kind: 'clipped', box: box(r), note: `truncated “${(el.textContent || '').trim().slice(0, 24)}”` });
    // A horizontal scroller whose children run past its edge with no fade or arrow hint.
    if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 4 && el.scrollLeft + el.clientWidth < el.scrollWidth - 4 && s.maskImage === 'none' && (s as unknown as Record<string, string>).webkitMaskImage === 'none') out.findings.push({ kind: 'clipped', box: box(r), note: 'row continues off screen with no hint' });
  }
  // Coverage: share of the main column (below the header, above the player) holding text, controls or images.
  for (const img of Array.from(document.querySelectorAll('main img, main canvas'))) { const r = img.getBoundingClientRect(); if (onScreen(r) && visible(img)) covered.push(r); }
  const main = document.querySelector('main')!.getBoundingClientRect(); const player = document.querySelector('.player-footer')?.getBoundingClientRect(); const header = document.querySelector('.topbar, .mobile-header')?.getBoundingClientRect();
  const top = Math.max(main.top, 0, header && header.height ? header.bottom : 0), bottom = Math.min(vh, player && player.height && !document.querySelector('.player-open') ? player.top : vh), left = Math.max(main.left, 0), right = Math.min(main.right, vw);
  const cell = 8; let used = 0, all = 0;
  for (let y = top; y < bottom; y += cell) for (let x = left; x < right; x += cell) { all++; if (covered.some(r => x >= r.left - 12 && x <= r.right + 12 && y >= r.top - 12 && y <= r.bottom + 12)) used++; }
  out.coverage = all ? used / all : 1;
  out.heading = Array.from(document.querySelectorAll('h1, h2, [role="tablist"]')).some(h => { const r = h.getBoundingClientRect(); return visible(h) && onScreen(r) && r.top < vh * .3; });
  return out;
}

const luminance = (r: number, g: number, b: number) => { const c = [r, g, b].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
const ratio = (a: number, b: number) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
const parse = (color: string) => { const m = color.match(/[\d.]+/g)!.map(Number); return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 }; };

async function capture(page: Page, file: string, minTarget: number, density: number, extra: Finding[] = [], top = true) {
  await page.evaluate(settle); await page.waitForTimeout(150);
  const shown = await page.screenshot({ path: file + '.png' });
  const final = await page.evaluate(() => { const s = document.scrollingElement!; return s.scrollTop + s.clientHeight >= s.scrollHeight - 2; });
  const data = await page.evaluate(inspect, [minTarget, final] as [number, boolean]);
  // The same frame with every glyph made transparent: what each word actually sits on.
  const hide = await page.addStyleTag({ content: '*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; } input::placeholder { color: transparent !important; }' });
  await page.waitForTimeout(80);
  const bare = await sharp(await page.screenshot()).raw().toBuffer({ resolveWithObject: true });
  await hide.evaluate(node => (node as Element).remove());
  const findings: Finding[] = [...data.findings, ...extra];
  const { width, channels } = bare.info;
  let worst = 21;
  for (const t of data.text) {
    const c = parse(t.color); const alpha = c.a * t.alpha; if (alpha < .05) continue;
    const lums: number[] = []; const x0 = Math.floor(t.x * density), y0 = Math.floor(t.y * density), x1 = Math.ceil((t.x + t.w) * density), y1 = Math.ceil((t.y + t.h) * density);
    const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 8));
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) { const i = (y * width + x) * channels; if (i + 2 >= bare.data.length) continue; lums.push(luminance(bare.data[i], bare.data[i + 1], bare.data[i + 2])); }
    if (!lums.length) continue; lums.sort((a, b) => a - b);
    const textLum = (bg: number) => { const bgRgb = Math.round(255 * (bg <= .0031308 ? bg * 12.92 : 1.055 * bg ** (1 / 2.4) - .055)); return luminance(bgRgb * (1 - alpha) + c.r * alpha, bgRgb * (1 - alpha) + c.g * alpha, bgRgb * (1 - alpha) + c.b * alpha); };
    // Worst case over the brightest/darkest tenth of the backdrop, not a lucky average.
    const fg = luminance(c.r, c.g, c.b); const bg = fg > lums[Math.floor(lums.length / 2)] ? lums[Math.floor(lums.length * .9)] : lums[Math.floor(lums.length * .1)];
    const value = ratio(alpha < 1 ? textLum(bg) : fg, bg); worst = Math.min(worst, value);
    if (value < (t.large ? 3 : 4.5)) findings.push({ kind: 'contrast', box: t, note: `${value.toFixed(2)}:1 “${t.label.slice(0, 24)}”` });
  }
  if (top && !data.heading) findings.push({ kind: 'heading', box: { x: 0, y: 0, w: 0, h: 0 }, note: 'no visible h1/h2 in the top 30%' });
  const empty = Math.max(0, Math.round(((1 - data.coverage) - .4) * 20));
  for (let i = 0; i < empty; i++) findings.push({ kind: 'emptiness', box: { x: 0, y: 0, w: 0, h: 0 }, note: `${Math.round((1 - data.coverage) * 100)}% of the first screen unused` });
  const deductions = Object.fromEntries(Object.entries(weights).map(([kind, w]) => [kind, Math.min(w.cap, findings.filter(f => f.kind === kind).length * w.each)]));
  const score = Math.max(0, 100 - Object.values(deductions).reduce((a, b) => a + b, 0));
  await annotate(shown, findings, density, file + '-annotated.png');
  return { score, deductions, coverage: Math.round(data.coverage * 100), worstContrast: Number(worst.toFixed(2)), findings: findings.map(f => ({ kind: f.kind, note: f.note })) };
}

const colors: Record<Kind, string> = { contrast: '#ff3b3b', scenery: '#ffb000', target: '#00e5ff', clipped: '#ff4fd8', tiny: '#b6ff3b', emptiness: '#ffffff', heading: '#ffffff', axe: '#ffffff' };
async function annotate(png: Buffer, findings: Finding[], density: number, file: string) {
  const { width = 0, height = 0 } = await sharp(png).metadata();
  const boxes = findings.filter(f => f.box.w > 0).map(f => `<rect x="${f.box.x * density}" y="${f.box.y * density}" width="${f.box.w * density}" height="${f.box.h * density}" fill="none" stroke="${colors[f.kind]}" stroke-width="${2 * density}" stroke-dasharray="${f.kind === 'scenery' ? `${6 * density} ${3 * density}` : 'none'}"/>`).join('');
  await sharp(png).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${boxes}</svg>`) }]).toFile(file);
}

async function scrollable(page: Page) { return page.evaluate(() => { const s = document.scrollingElement!; return s.scrollHeight > s.clientHeight + 40; }); }

for (const { name, width, height, density, target } of viewports) {
  test(`score ${name}`, async ({ browser }) => {
    test.setTimeout(120_000);
    const directory = fileURLToPath(new URL(`../.impeccable/score/${process.env.UX_LABEL}/`, import.meta.url)); await mkdir(directory, { recursive: true });
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: density, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(cssScene);
    const page = await context.newPage();
    await mockPortal(page); await page.goto(String(test.info().project.use.baseURL));
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    const results: Record<string, unknown> = {};
    for (const screen of screens) {
      if (!(await open(page, screen))) { await page.keyboard.press('Escape'); continue; }
      await page.waitForTimeout(400); await page.evaluate(() => scrollTo(0, 0));
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      const axeFindings: Finding[] = axe.violations.map(v => ({ kind: 'axe', box: { x: 0, y: 0, w: 0, h: 0 }, note: `${v.id} (${v.nodes.length})` }));
      results[`${screen}`] = await capture(page, `${directory}${name}-${screen}`, target, density, axeFindings, screen !== 'player');
      if (screen !== 'player' && await scrollable(page)) {
        await page.evaluate(() => scrollTo(0, document.scrollingElement!.scrollHeight));
        results[`${screen}-end`] = await capture(page, `${directory}${name}-${screen}-end`, target, density, [], false);
      }
    }
    const scores = Object.values(results).map(r => (r as { score: number }).score);
    await writeFile(`${directory}${name}.json`, JSON.stringify({ viewport: name, average: Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)), results }, null, 2));
    await context.close();
  });
}
