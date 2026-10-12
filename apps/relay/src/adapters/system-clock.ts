import type { Clock } from '@remote-control/protocol';

/** The real wall clock; the only module in the relay allowed to call `Date.now()`. */
export const systemClock: Clock = {
  now: () => Date.now(),
};
