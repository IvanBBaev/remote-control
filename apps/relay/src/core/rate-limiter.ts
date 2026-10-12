import type { Clock } from '@remote-control/protocol';

export interface RateLimit {
  /** Requests allowed per window. */
  readonly max: number;
  readonly windowMs: number;
}

export type RateLimitResult =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number };

/** Above this many tracked keys, every hit first drops the windows that have ended. */
const PRUNE_THRESHOLD = 10_000;

/**
 * In-process fixed-window counters keyed by an arbitrary string (`ip:…`, `user:…`), on
 * the Clock port so tests drive time. One relay replica (D15) makes in-process state
 * sufficient; a second replica would need a shared store.
 */
export class FixedWindowRateLimiter {
  readonly #windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly clock: Clock) {}

  hit(key: string, limit: RateLimit): RateLimitResult {
    const now = this.clock.now();
    if (this.#windows.size > PRUNE_THRESHOLD) this.#prune(now);
    let window = this.#windows.get(key);
    if (window === undefined || now >= window.resetAt) {
      window = { count: 0, resetAt: now + limit.windowMs };
      this.#windows.set(key, window);
    }
    if (window.count >= limit.max) return { allowed: false, retryAfterMs: window.resetAt - now };
    window.count += 1;
    return { allowed: true };
  }

  /** Number of tracked keys (for tests and metrics). */
  get size(): number {
    return this.#windows.size;
  }

  #prune(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now >= window.resetAt) this.#windows.delete(key);
    }
  }
}
