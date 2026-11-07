import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// 诊断页与游戏分别构建，避免清空同一输出目录或混入正式游戏入口。
export default defineConfig({
  base:'./',
  root:'diagnostics/cloudbase',
  envDir:process.cwd(),
  build:{outDir:resolve('dist/cloudbase/site'),emptyOutDir:true},
});
