import type { Timer } from '@remote-control/phone-core/ports/timer';

/** The real clock; everything else takes `now` as an argument (ROADMAP §5). */
export function systemNow(): number {
  return Date.now();
}

/** The real clock and scheduler for the shared phone core. */
export const systemTimer: Timer = {
  now: systemNow,
  after(ms, callback) {
    const id = setTimeout(callback, ms);
    return {
      cancel: () => {
        clearTimeout(id);
      },
    };
  },
};
