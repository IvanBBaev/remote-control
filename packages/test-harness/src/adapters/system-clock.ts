import type { HarnessClock } from '../fake-clock.js';

/** Wall time and real timers, for runs against a real browser (M1-12). */
export function createRealClock(): HarnessClock {
  return {
    now: () => Date.now(),
    after(ms, callback) {
      const handle = setTimeout(callback, Math.max(0, ms));
      return { cancel: () => clearTimeout(handle) };
    },
  };
}
