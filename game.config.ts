import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// 游戏独立输出到 game 目录，相对资源地址允许部署在既有站点的子路径下。
export default defineConfig({
  base: './', root: 'game', envDir: process.cwd(),
  build: { outDir: resolve('dist/cloudbase/game'), emptyOutDir: true },
});
