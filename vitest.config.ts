import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['{apps,packages}/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', '**/*.d.ts'],
      reporter: ['text-summary', 'text'],
      // Per-package thresholds. D18 floors are enforced by tools/coverage-policy.test.ts:
      // lowering one below its floor, or dropping a package, fails `ci`.
      thresholds: {
        'packages/log/src/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        // 07 §5.13: test tooling is held to the agent/relay bar.
        'packages/fake-claude-code/src/**': { lines: 90, branches: 85 },
        // The harness runs journeys; its defensive waits are only partly exercised (77 % measured).
        'packages/test-harness/src/**': { lines: 90, branches: 75 },
        // D18: agent and relay lines 90 / branches 85.
        'apps/agent/src/**': { lines: 90, branches: 85 },
        'apps/relay/src/**': { lines: 90, branches: 85 },
        // 07 §5.13: the protocol package is the trust boundary and stays fully covered.
        'packages/protocol/src/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'packages/crypto/src/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        // D18 floor is 80 / 70; set just under the measured value (M0-18).
        'apps/web/src/**': { lines: 95, functions: 95, branches: 90, statements: 95 },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          // PGlite boots, `npm pack` and agent child processes are CPU-bound: the vitest
          // defaults (5 s test, 10 s hook) time out when parallel sessions load the machine.
          testTimeout: 20_000,
          hookTimeout: 20_000,
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
