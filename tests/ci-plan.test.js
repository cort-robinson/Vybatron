import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { plan } from '../scripts/ci-plan.mjs';

test('a bot-only change skips the browser suite and the Android build', () => {
  assert.deepEqual(plan(['src/commands/play.js', 'tests/commands.test.js', 'package.json', 'docs/adr/0001.md']), { browser: false, android: false });
});

test('a portal web or server change runs the browser suite only', () => {
  assert.deepEqual(plan(['portal/web/src/App.tsx']), { browser: true, android: false });
  assert.deepEqual(plan(['portal/server/src/security.js']), { browser: true, android: false });
  assert.deepEqual(plan(['portal/Dockerfile']), { browser: true, android: false });
});

test('an Android change runs the Android build only', () => {
  assert.deepEqual(plan(['portal/android/app/build.gradle.kts']), { browser: false, android: true });
});

test('a change to the pipeline itself runs everything', () => {
  for (const file of ['.github/workflows/ci.yml', 'scripts/ci-plan.mjs', '.github/actions/setup/action.yml', '.nvmrc']) {
    assert.deepEqual(plan([file]), { browser: true, android: true }, file);
  }
});

test('an empty or unreadable change list runs everything', () => {
  assert.deepEqual(plan([]), { browser: true, android: true });
  assert.deepEqual(plan(['', '  ']), { browser: true, android: true });
});

test('the command prints GitHub outputs from a newline-separated list', () => {
  const output = execFileSync(process.execPath, ['scripts/ci-plan.mjs'], { input: 'src/index.js\nportal/android/README.md\n', encoding: 'utf8' });
  assert.equal(output, 'browser=false\nandroid=true\n');
});
