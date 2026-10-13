import { afterEach, describe, expect, it, vi } from 'vitest';

import { systemTimer } from './system-clock.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('system timer', () => {
  it('reads the wall clock and runs or cancels callbacks', () => {
    vi.useFakeTimers({ now: 1_000 });
    expect(systemTimer.now()).toBe(1_000);
    const fired: string[] = [];
    systemTimer.after(10, () => fired.push('a'));
    systemTimer.after(-5, () => fired.push('now')).cancel();
    systemTimer.after(20, () => fired.push('b')).cancel();
    vi.advanceTimersByTime(30);
    expect(fired).toEqual(['a']);
  });
});
