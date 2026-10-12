import type { Clock } from '../ports/clock.js';

/** The real wall clock; the only place in the agent allowed to read `Date.now()`. */
export const systemClock: Clock = { now: () => Date.now() };
