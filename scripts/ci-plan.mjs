#!/usr/bin/env node
// Decides which slow CI jobs a change needs, from the paths it touches.
//
//   git diff --name-only <base> <head> | node scripts/ci-plan.mjs
//
// Prints `browser=true|false` and `android=true|false` lines for $GITHUB_OUTPUT.
// The lint, bot and portal jobs always run; only the Playwright shards and the
// Android build are skipped, and only when no file they read changed. An empty or
// unreadable list runs everything.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Any change to how CI plans or runs its jobs re-runs everything.
const pipeline = [/^\.github\/workflows\/ci\.yml$/, /^\.github\/actions\//, /^scripts\/ci-plan\.mjs$/, /^\.(npmrc|nvmrc|node-version)$/];

export const SUITES = {
  // The browser suite builds and serves portal/web, and link.spec reads the
  // portal server's Content-Security-Policy, so every portal path but the app.
  // Vite also reads ancestor workspace files (package.json, lerna.json,
  // pnpm-workspace.yaml) and can then load a root PostCSS or other config, so
  // every repository-root file but prose counts too.
  browser: [/^portal\/(?!android\/)/, /^[^/]+$(?<!\.md)/, ...pipeline],
  android: [/^portal\/android\//, ...pipeline],
};

export function plan(files) {
  const paths = files.map(file => file.trim()).filter(Boolean);
  return Object.fromEntries(Object.entries(SUITES).map(([suite, patterns]) =>
    [suite, paths.length === 0 || paths.some(path => patterns.some(pattern => pattern.test(path)))]));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = plan(readFileSync(0, 'utf8').split('\n'));
  for (const [suite, needed] of Object.entries(result)) console.log(`${suite}=${needed}`);
}
