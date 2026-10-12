import type { Clock } from '@remote-control/protocol';

/**
 * Outstanding WebAuthn challenges, single-use and short-lived: `take` removes the entry,
 * so a replayed response finds nothing. In memory, which is enough for one replica
 * (D15); a restart only forces the user to tap again. The cap bounds memory against
 * unauthenticated option requests — when full, the oldest entry is evicted.
 */
export class ChallengeStore<T> {
  readonly #entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly ttlMs: number,
    private readonly capacity = 10_000,
  ) {}

  put(challenge: string, value: T): void {
    if (this.#entries.size >= this.capacity) this.#evict();
    this.#entries.set(challenge, { value, expiresAt: this.clock.now() + this.ttlMs });
  }

  /** The value of a live challenge, removing it; `undefined` if unknown, used or expired. */
  take(challenge: string): T | undefined {
    const entry = this.#entries.get(challenge);
    if (entry === undefined) return undefined;
    this.#entries.delete(challenge);
    return this.clock.now() < entry.expiresAt ? entry.value : undefined;
  }

  get size(): number {
    return this.#entries.size;
  }

  #evict(): void {
    const now = this.clock.now();
    for (const [key, entry] of this.#entries) {
      if (now >= entry.expiresAt) this.#entries.delete(key);
    }
    if (this.#entries.size >= this.capacity) {
      const oldest = this.#entries.keys().next();
      if (oldest.done !== true) this.#entries.delete(oldest.value);
    }
  }
}
