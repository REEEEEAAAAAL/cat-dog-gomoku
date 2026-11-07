import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.npm-cache/**', 'docs/internal/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // 借助类型信息检查未处理或误用的 Promise，防止异步 RPC 错误脱离既有处理入口。
  { files: ['**/*.ts'], languageOptions: { parserOptions: { project: './tsconfig.json' } }, rules: {
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/consistent-type-imports': 'error',
  } },
);
