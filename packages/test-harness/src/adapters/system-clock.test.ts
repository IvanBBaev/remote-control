import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRealClock } from './system-clock.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('real clock', () => {
  it('reads the wall clock and runs or cancels callbacks', () => {
    vi.useFakeTimers({ now: 1_000 });
    const clock = createRealClock();
    expect(clock.now()).toBe(1_000);
    const fired: string[] = [];
    clock.after(10, () => fired.push('a'));
    clock.after(-5, () => fired.push('now'));
    clock.after(20, () => fired.push('b')).cancel();
    vi.advanceTimersByTime(30);
    expect(fired).toEqual(['now', 'a']);
  });
});
