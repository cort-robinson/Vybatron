import { defineConfig } from '@playwright/test';
const port = Number(process.env.PLAYWRIGHT_PORT || 4178);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PLAYWRIGHT_PORT.');
const origin = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: origin, channel: process.env.PLAYWRIGHT_CHANNEL || undefined, trace: 'retain-on-failure', screenshot: 'only-on-failure', serviceWorkers: 'block' },
  // A listener from another worktree must never supply this checkout's evidence.
  webServer: { command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`, url: origin, reuseExistingServer: false, timeout: 30_000 },
});
