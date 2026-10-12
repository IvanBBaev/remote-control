import type { Clock } from '@remote-control/protocol';

export interface TokenBucketLimit {
  /** Largest burst. */
  readonly capacity: number;
  /** Tokens added per second. */
  readonly perSecond: number;
}

/** Inbound frame budget of one socket (D15: 100 frames/s; overflow closes with 1008). */
export class TokenBucket {
  #tokens: number;
  #updatedAt: number;

  constructor(
    private readonly clock: Clock,
    private readonly limit: TokenBucketLimit,
  ) {
    this.#tokens = limit.capacity;
    this.#updatedAt = clock.now();
  }

  /** Takes one token; `false` when the budget is spent. */
  take(): boolean {
    const now = this.clock.now();
    const refill = (Math.max(0, now - this.#updatedAt) * this.limit.perSecond) / 1000;
    this.#tokens = Math.min(this.limit.capacity, this.#tokens + refill);
    this.#updatedAt = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}
