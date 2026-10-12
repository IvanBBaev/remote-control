import type { Clock, Random } from '@remote-control/protocol';

/** Deterministic clock for tests: starts at `startMs` and advances `stepMs` per read. */
export function steppingClock(startMs = Date.UTC(2026, 0, 1), stepMs = 1000): Clock {
  let current = startMs - stepMs;
  return {
    now: () => {
      current += stepMs;
      return current;
    },
  };
}

/** Deterministic, non-cryptographic byte source for tests (xorshift32). */
export function seededRandom(seed = 1): Random {
  let state = seed >>> 0 || 1;
  return {
    bytes: (length) => {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        out[i] = state & 0xff;
      }
      return out;
    },
  };
}
