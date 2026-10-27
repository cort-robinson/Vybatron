// Writes src/icons.tsx: the Phosphor icons the portal uses, with only the weights it draws.
// Each @phosphor-icons/react icon module carries all six weights, so importing it directly ships
// about five unused drawings per icon. Run `node scripts/build-icon-set.mjs` after using a new icon
// or weight; the build runs it with --check and fails while src/icons.tsx is out of date.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const web = fileURLToPath(new URL('../', import.meta.url));
const source = join(web, 'src');
const output = join(source, 'icons.tsx');
const phosphor = join(web, 'node_modules/@phosphor-icons/react');
const weights = ['thin', 'light', 'regular', 'bold', 'fill', 'duotone'];

async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else if (['.ts', '.tsx'].includes(extname(path)) && path !== output) found.push(path);
  }
  return found;
}

// The attributes of the JSX tag starting at `start`, up to its closing > outside any braces.
function attributes(text, start) {
  let depth = 0; let quote = null;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '{') depth++;
    else if (char === '}') depth--;
    else if (char === '>' && depth === 0) return text.slice(start, index);
  }
  throw new Error('Unterminated JSX tag');
}

// The tag's own weight attribute, not one on an element passed in another attribute. A weight
// written any other way than weight="x" or weight={…} is returned unparsed, never skipped.
function ownWeight(tag) {
  let depth = 0;
  for (let index = 0; index < tag.length; index++) {
    if (tag[index] === '{') {
      if (depth === 0 && tag.startsWith('{...', index)) return { unparsed: true };
      depth++;
    } else if (tag[index] === '}') depth--;
    else if (depth === 0 && /^\sweight(?![\w-])/.test(tag.slice(index - 1, index + 7))) {
      const match = /^weight\s*=\s*(?:["']([a-z]+)["']|\{)/.exec(tag.slice(index));
      return match ? Object.assign(match, { index }) : { unparsed: true };
    }
  }
  return null;
}

// The {…} expression starting at `start`.
function expression(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === '{') depth++;
    else if (text[index] === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error('Unterminated JSX expression');
}

const used = new Map();
const problems = [];
for (const path of await files(source)) {
  const text = await readFile(path, 'utf8');
  const name = relative(web, path);
  if (/from '@phosphor-icons\/react'/.test(text.replace(/^import type .*$/gm, ''))) problems.push(`${name}: import icons from the local icons module, not @phosphor-icons/react`);
  const imported = /import \{([^}]*)\} from '\.{1,2}\/(?:\.\.\/)*icons'/.exec(text);
  const names = new Set((imported?.[1] || '').split(',').map(item => item.trim()).filter(item => /Icon$/.test(item)));
  for (const icon of names) if (!used.has(icon)) used.set(icon, new Set());
  // An icon passed around as a value may be drawn anywhere at the default weight.
  const body = imported ? text.replace(imported[0], '') : text;
  for (const icon of names) if (new RegExp(`(?<![<\\w])${icon}\\b`).test(body)) used.get(icon).add('regular');
  for (const match of text.matchAll(/<([A-Za-z_.]+)\b/g)) {
    const tag = attributes(text, match.index + match[0].length);
    const weight = ownWeight(tag);
    if (!weight) { if (names.has(match[1])) used.get(match[1]).add('regular'); continue; }
    const line = text.slice(0, match.index).split('\n').length;
    if (!names.has(match[1])) {
      if (!weight.unparsed) problems.push(`${name}:${line}: weight on <${match[1]}> must name an imported icon directly`);
      continue;
    }
    if (weight.unparsed) { problems.push(`${name}:${line}: write <${match[1]}>'s weight as weight="x" or weight={…} with literal weights, not spread props`); continue; }
    const value = weight[1] ? [weight[1]] : [...expression(tag, weight.index + weight[0].length - 1).matchAll(/'([a-z]+)'/g)].map(item => item[1]);
    if (!value.length || value.some(item => !weights.includes(item))) problems.push(`${name}:${line}: weight on <${match[1]}> must be written as literal weights`);
    for (const item of value) used.get(match[1]).add(item);
  }
}

const { version } = JSON.parse(await readFile(join(phosphor, 'package.json'), 'utf8'));
const entries = [];
for (const icon of [...used.keys()].sort()) {
  const definition = join(phosphor, `dist/defs/${icon.replace(/Icon$/, '')}.es.js`);
  let drawings;
  try { drawings = (await import(pathToFileURL(definition))).default; } catch { problems.push(`${icon} is not a Phosphor icon`); continue; }
  if (!used.get(icon).size) used.get(icon).add('regular');
  const drawn = weights.filter(weight => used.get(icon).has(weight)).map(weight => {
    const paths = [drawings.get(weight).props.children].flat().filter(Boolean).map(path => {
      const { d, ...rest } = path.props;
      if (path.type !== 'path' || Object.keys(rest).length) throw new Error(`${icon} ${weight} draws more than paths`);
      return JSON.stringify(d);
    });
    return `${weight}: [${paths.join(', ')}]`;
  });
  entries.push(`export const ${icon} = /* @__PURE__ */ icon('${icon}', { ${drawn.join(', ')} });`);
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }

const generated = `// Generated by scripts/build-icon-set.mjs from @phosphor-icons/react ${version}. Do not edit.
// The Phosphor icons the portal uses, each with only the weights it draws. Phosphor's own modules
// carry all six weights per icon. A weight left out falls back to the icon's first one; IconContext
// weights are not used here.
import { forwardRef, type ReactElement } from 'react';
import type { Icon, IconProps, IconWeight } from '@phosphor-icons/react';
import IconBase from '@phosphor-icons/react/dist/lib/IconBase';

function icon(name: string, drawn: Partial<Record<IconWeight, string[]>>): Icon {
  const drawings = new Map(Object.entries(drawn).map(([weight, paths]) =>
    [weight as IconWeight, <>{paths.map(d => <path key={d} d={d} />)}</> as ReactElement]));
  const fallback = drawings.keys().next().value;
  const component = forwardRef<SVGSVGElement, IconProps>(({ weight = 'regular', ...props }, ref) =>
    <IconBase ref={ref} {...props} weight={drawings.has(weight) ? weight : fallback} weights={drawings} />);
  component.displayName = name;
  return component;
}

${entries.join('\n')}
`;

if (process.argv.includes('--check')) {
  const current = await readFile(output, 'utf8').catch(() => '');
  if (current !== generated) {
    console.error('src/icons.tsx is out of date. Run `node scripts/build-icon-set.mjs` in portal/web.');
    process.exit(1);
  }
  console.log(`Icon set current: ${entries.length} icons.`);
} else {
  await writeFile(output, generated);
  console.log(`Wrote src/icons.tsx: ${entries.length} icons.`);
}
