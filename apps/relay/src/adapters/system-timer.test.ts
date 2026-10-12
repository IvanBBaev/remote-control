import { afterEach, describe, expect, it, vi } from 'vitest';

import { systemTimer } from './system-timer.js';

describe('systemTimer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once after the delay and can be cancelled', () => {
    vi.useFakeTimers();
    const fired: string[] = [];
    systemTimer.after(100, () => fired.push('a'));
    const cancelled = systemTimer.after(100, () => fired.push('b'));
    cancelled.cancel();
    systemTimer.after(-5, () => fired.push('c'));
    vi.advanceTimersByTime(0);
    expect(fired).toEqual(['c']);
    vi.advanceTimersByTime(100);
    expect(fired).toEqual(['c', 'a']);
  });

  it('chains delays longer than a Node timer allows', () => {
    vi.useFakeTimers();
    const max = 2 ** 31 - 1;
    let fired = false;
    const handle = systemTimer.after(max + 1_000, () => (fired = true));
    vi.advanceTimersByTime(max);
    expect(fired).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(fired).toBe(true);

    let late = false;
    const cancelled = systemTimer.after(max + 1_000, () => (late = true));
    vi.advanceTimersByTime(max);
    cancelled.cancel();
    vi.advanceTimersByTime(2_000);
    expect(late).toBe(false);
    handle.cancel();
  });
});
