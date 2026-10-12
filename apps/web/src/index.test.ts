import { describe, expect, it } from 'vitest';

import { packageName } from './index.js';

describe('@remote-control/web', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@remote-control/web');
  });
});
