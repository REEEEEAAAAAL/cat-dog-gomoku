import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir:'./tests/cloudbase-e2e',outputDir:'test-results/diagnostics',workers:1,
  use:{baseURL:process.env.CLOUDBASE_DIAGNOSTIC_URL||'http://127.0.0.1:18789',trace:'off',screenshot:'off'},
  projects:[{name:'edge',use:{...devices['Desktop Edge'],channel:'msedge'}}],
  webServer:process.env.CLOUDBASE_DIAGNOSTIC_URL?undefined:{command:'node node_modules/vite/bin/vite.js preview --config cloudbase-probe.config.ts --host 127.0.0.1 --port 18789',
    url:'http://127.0.0.1:18789',reuseExistingServer:false,timeout:20_000},
});
