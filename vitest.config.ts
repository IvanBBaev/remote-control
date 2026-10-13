import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['{apps,packages}/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', '**/*.d.ts'],
      reporter: ['text-summary', 'text'],
      // Per-package thresholds; packages without an entry are reported, not gated.
      thresholds: {
        'packages/log/src/**': { lines: 100 },
        'packages/fake-claude-code/src/**': { lines: 90 },
        'apps/agent/src/**': { lines: 90 },
        // 07 §5.13: the protocol package is the trust boundary and stays fully covered.
        'packages/protocol/src/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'packages/crypto/src/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        // D18: relay lines 90 / branches 85.
        'apps/relay/src/**': { lines: 90, branches: 85 },
        // M0-18: the PWA's probe, gate and route table; set just under the measured value.
        'apps/web/src/**': { lines: 95, functions: 95, branches: 90, statements: 95 },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['{apps,packages}/*/src/**/*.test.ts', 'tools/**/*.test.ts'],
          exclude: ['apps/web/**', '**/node_modules/**', '**/*.pg-real.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          // Real Postgres (M0-08); every suite skips unless RC_TEST_DATABASE_URL is set.
          name: 'pg-real',
          environment: 'node',
          include: ['apps/relay/src/**/*.pg-real.test.ts'],
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
