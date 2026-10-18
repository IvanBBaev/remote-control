import { describe, expect, it } from 'vitest';

import { isWindowsBusy, retryTransient } from './retry-transient.js';

const busy = (): Error => Object.assign(new Error('busy'), { code: 'EBUSY' });

describe('isWindowsBusy', () => {
  it('flags busy codes on win32 only', () => {
    expect(isWindowsBusy(busy(), 'win32')).toBe(true);
    expect(isWindowsBusy(Object.assign(new Error('x'), { code: 'EPERM' }), 'win32')).toBe(true);
    expect(isWindowsBusy(busy(), 'linux')).toBe(false);
    expect(isWindowsBusy(Object.assign(new Error('x'), { code: 'ENOENT' }), 'win32')).toBe(false);
    expect(isWindowsBusy(new Error('no code'), 'win32')).toBe(false);
    expect(isWindowsBusy(undefined, 'win32')).toBe(false);
  });
});

describe('retryTransient', () => {
  const options = { attempts: 3, delayMs: 1, isTransient: () => true };

  it('returns once the operation stops failing', async () => {
    let calls = 0;
    const result = await retryTransient(() => {
      calls += 1;
      return calls < 3 ? Promise.reject(busy()) : Promise.resolve('ok');
    }, options);
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('rethrows the last error after the attempts run out', async () => {
    let calls = 0;
    await expect(
      retryTransient(() => {
        calls += 1;
        return Promise.reject(busy());
      }, options),
    ).rejects.toThrow('busy');
    expect(calls).toBe(3);
  });

  it('does not retry an error that is not transient', async () => {
    let calls = 0;
    await expect(
      retryTransient(
        () => {
          calls += 1;
          return Promise.reject(new Error('fatal'));
        },
        { ...options, isTransient: () => false },
      ),
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });
});
