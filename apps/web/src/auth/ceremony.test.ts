import { describe, expect, it } from 'vitest';

import { classifyFailure, isCancelled } from './ceremony.js';
import { OfflineError, RelayError } from './relay-api.js';

describe('classifyFailure', () => {
  it.each([
    [new DOMException('x', 'NotAllowedError'), 'cancelled'],
    [new DOMException('x', 'AbortError'), 'cancelled'],
    [new OfflineError(), 'offline'],
    [new RelayError(429, 'rate_limited', 60), 'rate_limited'],
    [new RelayError(403, 'invalid_invite'), { relay: 'invalid_invite' }],
    [new DOMException('x', 'InvalidStateError'), 'failed'],
    ['not an error', 'failed'],
  ])('%s → %j', (error, failure) => {
    expect(classifyFailure(error)).toEqual(failure);
  });

  it('only treats errors as cancellations', () => {
    expect(isCancelled({ name: 'NotAllowedError' })).toBe(false);
  });
});
