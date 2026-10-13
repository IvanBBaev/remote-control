import { defineConfig, devices } from '@playwright/test';

import { CONTROL_PORT, RELAY_PORT } from './ports.js';

const ci = process.env['CI'] !== undefined;

// M1-12 (07 §5.10): the PWA in an emulated iPhone against the harness relay and agents.
// Expects `apps/web/dist` built (`pnpm test:e2e` builds it first); the relay serves it,
// since the service worker only exists in a build.
export default defineConfig({
  testDir: './specs',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: 2,
  retries: ci ? 1 : 0,
  forbidOnly: ci,
  reporter: ci
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${String(RELAY_PORT)}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'tsx server.ts',
      url: `http://localhost:${String(RELAY_PORT)}/health`,
      reuseExistingServer: !ci,
      stdout: 'pipe',
      timeout: 60_000,
      env: { E2E_RELAY_PORT: String(RELAY_PORT), E2E_CONTROL_PORT: String(CONTROL_PORT) },
    },
  ],
  projects: [
    {
      name: 'mobile-chromium',
      // The full Chromium in new headless mode: the headless shell denies notifications.
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        channel: 'chromium',
      },
      testIgnore: /(webkit|desktop)\.spec\.ts$/,
    },
    {
      name: 'mobile-webkit',
      use: { ...devices['iPhone 13'] },
      testMatch: /webkit\.spec\.ts$/,
    },
    {
      // M2-05: the two-pane layout from 900 px, on a laptop-sized window.
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        channel: 'chromium',
      },
      testMatch: /desktop\.spec\.ts$/,
    },
  ],
});
