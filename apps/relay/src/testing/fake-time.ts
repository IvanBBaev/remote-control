import type { Clock } from '@remote-control/protocol';

import type { Timer } from '../ports/timer.js';

interface Scheduled {
  readonly at: number;
  readonly order: number;
  readonly callback: () => void;
}

/** A Clock and a Timer that only move when a test calls `advance`. */
export interface FakeTime {
  readonly clock: Clock;
  readonly timer: Timer;
  /** Moves time forward, firing every due callback in deadline order. */
  advance(ms: number): void;
  /** Callbacks scheduled and not yet fired or cancelled. */
  readonly pending: number;
}

export function createFakeTime(start = Date.UTC(2026, 9, 1)): FakeTime {
  let now = start;
  let order = 0;
  const scheduled = new Set<Scheduled>();

  const next = (until: number): Scheduled | undefined => {
    let earliest: Scheduled | undefined;
    for (const entry of scheduled) {
      if (entry.at > until) continue;
      if (
        earliest === undefined ||
        entry.at < earliest.at ||
        (entry.at === earliest.at && entry.order < earliest.order)
      ) {
        earliest = entry;
      }
    }
    return earliest;
  };

  return {
    clock: { now: () => now },
    timer: {
      after(ms, callback) {
        const entry: Scheduled = { at: now + Math.max(0, ms), order: order++, callback };
        scheduled.add(entry);
        return { cancel: () => scheduled.delete(entry) };
      },
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
