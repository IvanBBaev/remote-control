import type { Timer } from '../ports/timer.js';

/** The real clock; the only module of the PWA allowed to call `Date.now()`. */
export const systemTimer: Timer = {
  now: () => Date.now(),
  after(ms, callback) {
    const handle = setTimeout(callback, Math.max(0, ms));
    return { cancel: () => clearTimeout(handle) };
  },
};
