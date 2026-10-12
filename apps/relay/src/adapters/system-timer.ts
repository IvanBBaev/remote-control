import type { Timer } from '../ports/timer.js';

/** Largest delay a Node timer accepts; longer waits are chained. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * `Timer` over the Node event loop. Handles are `unref`ed: heartbeat and ack timers
 * never keep the process alive on their own (shutdown exits explicitly, D15).
 */
export const systemTimer: Timer = {
  after(ms, callback) {
    let remaining = Math.max(0, ms);
    let handle: NodeJS.Timeout;
    const schedule = (): void => {
      const step = Math.min(remaining, MAX_TIMER_MS);
      remaining -= step;
      handle = setTimeout(() => (remaining > 0 ? schedule() : callback()), step);
      handle.unref();
    };
    schedule();
    return { cancel: () => clearTimeout(handle) };
  },
};
