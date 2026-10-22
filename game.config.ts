import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './', root: 'game', envDir: process.cwd(),
  build: { outDir: resolve('dist/cloudbase/game'), emptyOutDir: true },
});
