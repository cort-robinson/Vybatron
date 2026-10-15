import { defineConfig } from '@playwright/test';
const port = Number(process.env.PLAYWRIGHT_PORT || 4178);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PLAYWRIGHT_PORT.');
const origin = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  // Every test owns its page, routes and loopback fixture, so tests run in parallel.
  fullyParallel: true,
  workers: process.env.CI ? 2 : '50%',
  // A CI retry still marks the test flaky in the report instead of hiding it.
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: origin, channel: process.env.PLAYWRIGHT_CHANNEL || undefined, trace: 'retain-on-failure', screenshot: 'only-on-failure', serviceWorkers: 'block' },
  // A listener from another worktree must never supply this checkout's evidence.
  // Tests run against a fresh production build, which loads much faster than dev.
  webServer: { command: `npm run build && npx vite preview --host 127.0.0.1 --port ${port} --strictPort`, url: origin, reuseExistingServer: false, timeout: 120_000 },
});
