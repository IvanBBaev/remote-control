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
        // 07 §5.13: the protocol package is the trust boundary and stays fully covered.
        'packages/protocol/src/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['{apps,packages}/*/src/**/*.test.ts', 'tools/**/*.test.ts'],
          exclude: ['apps/web/**', '**/node_modules/**'],
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
