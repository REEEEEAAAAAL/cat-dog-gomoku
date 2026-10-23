import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/game-e2e', outputDir: 'test-results/game', workers: 1, timeout: 150000,
  expect: { timeout: 15000 },
  use: { baseURL: process.env.GOMOKU_URL || 'http://127.0.0.1:18790', trace: 'off', screenshot: 'only-on-failure' },
  projects: process.env.GOMOKU_BROWSER === 'chrome'
    ? [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }]
    : [{ name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge' } }],
  webServer: process.env.GOMOKU_URL ? undefined : {
    command: process.env.GOMOKU_LOCAL_SQL ? 'node node_modules/vite/bin/vite.js --config game.test.config.ts --configLoader runner --host 127.0.0.1 --port 18790 --strictPort'
      : 'node node_modules/vite/bin/vite.js preview --config game.config.ts --host 127.0.0.1 --port 18790',
    url: 'http://127.0.0.1:18790', reuseExistingServer: false, timeout: 45000,
  },
});
