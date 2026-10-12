import type { Clock } from '@remote-control/protocol';

/** The real wall clock; the only place in this package allowed to read `Date.now()`. */
export const systemClock: Clock = { now: () => Date.now() };
