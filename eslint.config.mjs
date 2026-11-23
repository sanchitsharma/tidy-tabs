// Lint setup modelled on GoogleChrome/chrome-extensions-samples (ESLint recommended + Prettier).
import js from '@eslint/js';
import globals from 'globals';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

export default [
  js.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    rules: {
      'prettier/prettier': ['error'],
      'no-var': ['error'],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions, ...globals.serviceworker },
    },
  },
  {
    // Node-side code: the native host, unit tests, e2e tests, benchmark and scripts.
    files: [
      'native-host/**/*.js',
      '**/test/**/*.js',
      'extension/test-support/**/*.js',
      'tests/**/*.mjs',
      'bench/**/*.mjs',
      'scripts/**/*.mjs',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  { ignores: ['node_modules/**', 'dist/**', '.gstack/**', 'bench/runs/**', 'bench/snapshot/**', '**/fixtures/**'] },
];
