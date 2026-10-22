import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base:'./',
  root:'diagnostics/cloudbase',
  envDir:process.cwd(),
  build:{outDir:resolve('dist/cloudbase/site'),emptyOutDir:true},
});
