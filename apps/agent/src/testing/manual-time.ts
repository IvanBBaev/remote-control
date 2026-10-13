import type { Clock } from '../ports/clock.js';
import type { Timer } from '../ports/timer.js';

export interface ManualTime {
  readonly clock: Clock;
  readonly timer: Timer;
  /** Timers scheduled and not yet fired or cancelled. */
  active(): number;
  /** Moves the clock forward and fires every due timer in time order. */
  advance(ms: number): void;
}

/** A clock and a timer driven by hand, so tests never sleep (07 §5). */
export function manualTime(start = 1_760_000_000_000): ManualTime {
  let now = start;
  const timers: { at: number; callback: () => void; active: boolean }[] = [];
  return {
    clock: { now: () => now },
    timer: {
      after(ms, callback) {
        const entry = { at: now + ms, callback, active: true };
        timers.push(entry);
        return { cancel: () => (entry.active = false) };
      },
    },
    active: () => timers.filter((entry) => entry.active).length,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = timers
          .filter((entry) => entry.active && entry.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.active = false;
        now = Math.max(now, due.at);
        due.callback();
      }
      now = target;
    },
  };
}

/**
 * Lets queued promise work run (WebCrypto resolves outside the microtask queue) until
 * `predicate` holds; throws after `rounds` event-loop turns.
 */
export async function waitFor(predicate: () => boolean, rounds = 2_000): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('waitFor: condition not met');
}
