import type { Clock } from '@remote-control/protocol';

/** A cancellable one-shot timer (the relay's and the agent's `Timer` port share it). */
export interface TimerHandle {
  cancel(): void;
}

/** What the harness hands the relay and the agent as their `Clock` and `Timer` ports. */
export interface HarnessClock extends Clock {
  after(ms: number, callback: () => void): TimerHandle;
}

/**
 * One clock for every `Clock` and `Timer` port of the relay, the agent and the phone
 * (07 §5.6), so expiry is deterministic: time moves only when a test calls `advance`.
 */
export interface FakeClock extends HarnessClock {
  /** Moves time forward, firing every due callback in deadline order. */
  advance(ms: number): void;
  /** Callbacks scheduled and not yet fired or cancelled. */
  readonly pending: number;
}

interface Scheduled {
  readonly at: number;
  readonly order: number;
  readonly callback: () => void;
}

/** Default start: 2026-10-01T00:00:00Z. */
export const FAKE_CLOCK_START = Date.UTC(2026, 9, 1);

export function createFakeClock(start = FAKE_CLOCK_START): FakeClock {
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
    now: () => now,
    after(ms, callback) {
      const entry: Scheduled = { at: now + Math.max(0, ms), order: order++, callback };
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
