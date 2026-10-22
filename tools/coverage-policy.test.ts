import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import config from '../vitest.config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

type Metric = 'lines' | 'functions' | 'branches' | 'statements';
type Floor = Partial<Record<Metric, number>>;

/** D18 floors per package; `vitest.config.ts` may be stricter, never looser. */
const FLOORS: Record<string, Floor> = {
  'packages/protocol': { lines: 100, functions: 100, branches: 100, statements: 100 },
  'packages/crypto': { lines: 100, functions: 100, branches: 100, statements: 100 },
  'apps/agent': { lines: 90, branches: 85 },
  'apps/relay': { lines: 90, branches: 85 },
  'apps/web': { lines: 80, branches: 70 },
  'apps/mobile': { lines: 90, branches: 85 },
  'packages/phone-core': { lines: 80, branches: 70 },
  // 07 §5.13: test tooling sits on the agent/relay bar for lines.
  'packages/fake-claude-code': { lines: 90, branches: 85 },
  'packages/test-harness': { lines: 90 },
  'packages/log': { lines: 100 },
};

// Built from parts so this file does not match its own scan.
const PRAGMA = new RegExp(`(${['v8', 'c8', 'istanbul'].join('|')})\\s+ignore`);

function packages(): string[] {
  return ['apps', 'packages'].flatMap((group) =>
    readdirSync(join(ROOT, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => {
        try {
          return readdirSync(join(ROOT, group, entry.name, 'src')).length > 0;
        } catch {
          return false;
        }
      })
      .map((entry) => `${group}/${entry.name}`),
  );
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path);
    return /\.(ts|tsx|mts|cts|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

function thresholds(): Record<string, Floor> {
  const configured = config.test?.coverage;
  if (configured?.provider !== 'v8') throw new Error('coverage provider must be v8');
  return (configured.thresholds ?? {}) as unknown as Record<string, Floor>;
}

describe('coverage policy (D18)', () => {
  it('keeps coverage on in every run', () => {
    expect(config.test?.coverage?.enabled).toBe(true);
  });

  it('gates every package at or above its floor', () => {
    const configured = thresholds();
    for (const pkg of packages()) {
      const floor = FLOORS[pkg];
      expect(floor, `${pkg} has no D18 floor in tools/coverage-policy.test.ts`).toBeDefined();
      const actual = configured[`${pkg}/src/**`];
      expect(actual, `${pkg} has no threshold in vitest.config.ts`).toBeDefined();
      for (const [metric, minimum] of Object.entries(floor!) as [Metric, number][]) {
        expect(actual![metric] ?? 0, `${pkg} ${metric}`).toBeGreaterThanOrEqual(minimum);
      }
    }
  });

  it('allows no coverage-ignore pragmas in sources or tools', () => {
    const files = [
      ...packages().flatMap((pkg) => sources(join(ROOT, pkg, 'src'))),
      ...sources(join(ROOT, 'tools')),
    ];
    const offenders = files
      .filter((file) => PRAGMA.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });
});
