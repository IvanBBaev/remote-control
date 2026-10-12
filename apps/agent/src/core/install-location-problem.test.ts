import { describe, expect, it } from 'vitest';

import { installLocationProblem } from './install-location-problem.js';

describe('installLocationProblem', () => {
  const tmp = '/var/folders/xy/T';

  it.each([
    '/opt/homebrew/lib/node_modules/remotectl/dist/cli.mjs',
    '/usr/local/lib/node_modules/remotectl/dist/cli.mjs',
    '/Users/me/.nvm/versions/node/v22.20.0/lib/node_modules/remotectl/dist/cli.mjs',
    '/Users/me/Library/pnpm/global/5/node_modules/remotectl/dist/cli.js',
  ])('accepts a global install: %s', (path) => {
    expect(installLocationProblem(path, tmp)).toBeUndefined();
  });

  it('refuses the npx cache', () => {
    expect(
      installLocationProblem('/Users/me/.npm/_npx/1a2b3c/node_modules/remotectl/dist/cli.mjs', tmp),
    ).toMatch(/npx cache/);
    expect(
      installLocationProblem('C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\1a\\cli.mjs', tmp),
    ).toMatch(/npx cache/);
  });

  it('refuses the pnpm dlx cache', () => {
    expect(
      installLocationProblem(
        '/Users/me/Library/Caches/pnpm/dlx/abc/node_modules/remotectl/dist/cli.mjs',
        tmp,
      ),
    ).toMatch(/dlx/);
  });

  it('refuses the temporary directory (with or without a trailing slash)', () => {
    expect(installLocationProblem(`${tmp}/xfs-1/remotectl/dist/cli.mjs`, tmp)).toMatch(/temporary/);
    expect(installLocationProblem(`${tmp}/cli.mjs`, `${tmp}/`)).toMatch(/temporary/);
    expect(installLocationProblem('C:\\Temp\\cli.mjs', 'C:\\Temp')).toMatch(/temporary/);
    expect(installLocationProblem(`${tmp}x/cli.mjs`, tmp)).toBeUndefined();
  });

  it('refuses a source file', () => {
    expect(installLocationProblem('/repo/apps/agent/src/cli.ts', tmp)).toMatch(/built package/);
  });
});
