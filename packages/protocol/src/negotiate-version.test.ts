import { describe, expect, it } from 'vitest';

import { negotiateVersion } from './negotiate-version.js';
import { VERSION_TABLE } from './version.js';

describe('VERSION_TABLE', () => {
  it('is protocol v1 with floor 1', () => {
    expect(VERSION_TABLE).toEqual({ id: 'rc/v1', v: 1, min_supported: 1 });
  });
});

describe('negotiateVersion', () => {
  it.each([
    [{ min: 1, max: 1 }, { min: 1, max: 1 }, 1],
    [{ min: 1, max: 3 }, { min: 2, max: 5 }, 3],
    [{ min: 2, max: 5 }, { min: 1, max: 3 }, 3],
    [{ min: 1, max: 1 }, { min: 2, max: 2 }, null],
    [{ min: 4, max: 6 }, { min: 1, max: 3 }, null],
  ])('peer %j with local %j gives %s', (peer, local, expected) => {
    expect(negotiateVersion(peer, local)).toBe(expected);
  });

  it('uses the version table as the local range by default', () => {
    expect(negotiateVersion({ min: 1, max: 9 })).toBe(1);
    expect(negotiateVersion({ min: 2, max: 9 })).toBeNull();
  });
});
