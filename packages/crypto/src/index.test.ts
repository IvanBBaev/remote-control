import { describe, expect, it } from 'vitest';

import { packageName } from './index.js';

describe('@remote-control/crypto', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@remote-control/crypto');
  });
});
