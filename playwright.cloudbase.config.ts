import { defineConfig, devices } from '@playwright/test';

const localPort=Number(process.env.CLOUDBASE_PREVIEW_PORT||18789);
const localUrl=`http://127.0.0.1:${localPort}`;

export default defineConfig({
  testDir:'./tests/cloudbase-e2e',outputDir:'test-results/diagnostics',workers:1,
  use:{baseURL:process.env.CLOUDBASE_DIAGNOSTIC_URL||localUrl,trace:'off',screenshot:'off'},
  projects:[{name:'edge',use:{...devices['Desktop Edge'],channel:'msedge'}}],
  webServer:process.env.CLOUDBASE_DIAGNOSTIC_URL?undefined:{command:`node node_modules/vite/bin/vite.js preview --config cloudbase-probe.config.ts --host 127.0.0.1 --port ${localPort}`,
    url:localUrl,reuseExistingServer:false,timeout:20_000},
});
