import type { Timer } from './ports/timer.js';

/** A manual `Timer` for unit tests (the harness' `FakeClock` contract, without Node). */
export interface ManualTimer extends Timer {
  advance(ms: number): void;
  readonly pending: number;
}

export function createManualTimer(start = Date.UTC(2026, 9, 1)): ManualTimer {
  let now = start;
  let order = 0;
  const scheduled = new Set<{ at: number; order: number; callback: () => void }>();
  const next = (until: number) =>
    [...scheduled]
      .filter((entry) => entry.at <= until)
      .sort((a, b) => a.at - b.at || a.order - b.order)[0];
  return {
    now: () => now,
    after(ms, callback) {
      const entry = { at: now + Math.max(0, ms), order: order++, callback };
      scheduled.add(entry);
      return { cancel: () => void scheduled.delete(entry) };
    },
    advance(ms) {
      const until = now + ms;
      for (let entry = next(until); entry !== undefined; entry = next(until)) {
        scheduled.delete(entry);
        now = entry.at;
        entry.callback();
      }
      now = until;
    },
    get pending() {
      return scheduled.size;
    },
  };
}
