import eslint from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

// Time, randomness and raw crypto enter the code only through the Clock / Random
// ports and the packages/crypto adapters (ROADMAP §5, M0-01). Tests drive them with
// fakes, so a direct call is a lint error everywhere else.
const clockRandomRule = [
  'error',
  { object: 'Date', property: 'now', message: 'Use the Clock port.' },
  { object: 'Math', property: 'random', message: 'Use the Random port.' },
  { object: 'crypto', property: 'getRandomValues', message: 'Use the Random port.' },
];

const nodeCryptoRule = [
  'error',
  {
    paths: [
      { name: 'node:crypto', message: 'Use packages/crypto (WebCrypto only, D3).' },
      { name: 'crypto', message: 'Use packages/crypto (WebCrypto only, D3).' },
    ],
    patterns: [
      {
        group: ['@noble/*'],
        message: 'Use packages/crypto; only its noble backend imports @noble (ADR 0017).',
      },
    ],
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      '**/coverage/',
      'tools/lint-fixtures/',
      'apps/mobile/{ios,android,.expo}/',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            '*.mjs',
            'packages/*/bin/*.mjs',
            'apps/*/tsdown.config.ts',
            'apps/agent/scripts/*.mjs',
            'apps/*/drizzle.config.ts',
            'apps/relay/spike/*.js',
            'apps/web/vite.config.ts',
            'apps/web/scripts/*.mjs',
            'apps/mobile/metro.config.js',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-restricted-properties': clockRandomRule,
      'no-restricted-imports': nodeCryptoRule,
    },
  },
  {
    // The only places allowed to touch the real clock, RNG and crypto primitives.
    files: ['**/src/adapters/system-clock.ts', '**/src/adapters/system-random.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    files: ['packages/crypto/src/adapters/**/*.ts'],
    rules: { 'no-restricted-properties': 'off', 'no-restricted-imports': 'off' },
  },
  {
    // The pure-JS primitives for React Native (ADR 0017, M4-02).
    files: ['packages/crypto/src/backends/noble.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['*.mjs', 'packages/*/bin/*.mjs', 'apps/agent/scripts/*.mjs', 'apps/web/scripts/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { process: 'readonly', Buffer: 'readonly', URL: 'readonly' },
    },
  },
  {
    // Metro loads its config as CommonJS (M4-03).
    files: ['apps/mobile/metro.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // M0-03 device spike: plain browser scripts served as-is, outside the ports (no build,
    // removed after the verdict), so the clock/RNG rule does not apply.
    files: ['apps/relay/spike/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      sourceType: 'module',
      globals: Object.fromEntries(
        [
          'atob',
          'btoa',
          'console',
          'crypto',
          'document',
          'fetch',
          'indexedDB',
          'location',
          'matchMedia',
          'navigator',
          'Notification',
          'performance',
          'self',
          'TextDecoder',
          'TextEncoder',
          'URL',
        ].map((name) => [name, 'readonly']),
      ),
    },
    rules: { 'no-restricted-properties': 'off' },
  },
  prettierConfig,
);
