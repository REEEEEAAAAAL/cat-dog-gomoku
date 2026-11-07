import { defineConfig } from 'vitest/config';

// 这里只收集单元和隔离 SQL 测试；浏览器 spec 由各自 Playwright 配置执行。
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 15_000 },
});
