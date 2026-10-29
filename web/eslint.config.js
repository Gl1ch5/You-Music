import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'dist-web', 'scripts/out'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-syntax': [
        'error',
        { selector: "Literal[value=/^#[0-9a-fA-F]{3,8}$/]", message: 'Use design tokens (CSS variables) instead of hard-coded colours.' },
      ],
    },
  },
  {
    files: ['src/theme/builtin.ts', 'src/**/*.test.ts', 'src/bridge/mock.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
);
