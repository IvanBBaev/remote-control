import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { AGENT_VERSION } from './version.js';

describe('AGENT_VERSION', () => {
  it('matches package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(AGENT_VERSION).toBe(pkg.version);
  });
});
