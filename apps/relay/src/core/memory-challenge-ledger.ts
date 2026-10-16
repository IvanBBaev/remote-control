import type {
  ChallengeLedger,
  PendingChallenge,
  VerifiedDecision,
} from '../ports/challenge-ledger.js';

const DEFAULT_CAPACITY = 10_000;

interface Verified {
  readonly userId: string;
  readonly deviceId: string;
  readonly usedUntil: number;
  verifiedUntil: number;
}

/**
 * The {@link ChallengeLedger} in memory, which is enough for one replica (D15); a
 * restart only forces the user to tap again. Each table is capped against
 * unauthenticated option requests: a full challenge table evicts expired entries, then
 * the oldest live one; a full hash table answers `busy` until its entries expire.
 */
export class MemoryChallengeLedger implements ChallengeLedger {
  readonly #pending = new Map<string, { pending: PendingChallenge; expiresAt: number }>();
  /** Decision hash → its replay and admission windows. */
  readonly #hashes = new Map<string, Verified>();

  constructor(private readonly capacity = DEFAULT_CAPACITY) {}

  /** Outstanding challenges (tests). */
  get size(): number {
    return this.#pending.size;
  }

  put(key: string, pending: PendingChallenge, expiresAt: number, now: number): Promise<void> {
    if (this.#pending.size >= this.capacity) this.#evict(now);
    this.#pending.set(key, { pending, expiresAt });
    return Promise.resolve();
  }

  take(key: string, now: number): Promise<PendingChallenge | undefined> {
    const entry = this.#pending.get(key);
    this.#pending.delete(key);
    return Promise.resolve(
      entry !== undefined && now < entry.expiresAt ? entry.pending : undefined,
    );
  }

  usage(decisionHash: string, now: number): Promise<'free' | 'used' | 'busy'> {
    if (this.#isUsed(decisionHash, now)) return Promise.resolve('used');
    return Promise.resolve(this.#room(now) ? 'free' : 'busy');
  }

  markVerified(verified: VerifiedDecision, now: number): Promise<boolean> {
    if (this.#isUsed(verified.decisionHash, now)) return Promise.resolve(false);
    this.#hashes.delete(verified.decisionHash);
    // Evicting a live hash would reopen its replay window; a full table refuses instead.
    if (!this.#room(now)) return Promise.resolve(false);
    this.#hashes.set(verified.decisionHash, {
      userId: verified.userId,
      deviceId: verified.deviceId,
      usedUntil: verified.usedUntil,
      verifiedUntil: verified.verifiedUntil,
    });
    return Promise.resolve(true);
  }

  isVerified(
    userId: string,
    deviceId: string,
    decisionHash: string,
    now: number,
  ): Promise<boolean> {
    return Promise.resolve(this.#live(userId, deviceId, decisionHash, now) !== undefined);
  }

  consume(userId: string, deviceId: string, decisionHash: string, now: number): Promise<boolean> {
    const entry = this.#live(userId, deviceId, decisionHash, now);
    if (entry !== undefined) entry.verifiedUntil = now;
    return Promise.resolve(entry !== undefined);
  }

  #live(userId: string, deviceId: string, hash: string, now: number): Verified | undefined {
    const entry = this.#hashes.get(hash);
    const matches = entry?.userId === userId && entry.deviceId === deviceId;
    return matches && now < entry.verifiedUntil ? entry : undefined;
  }

  #isUsed(hash: string, now: number): boolean {
    const entry = this.#hashes.get(hash);
    return entry !== undefined && now < entry.usedUntil;
  }

  /** Drops expired hashes when the table is full; `false` if it is still full. */
  #room(now: number): boolean {
    if (this.#hashes.size < this.capacity) return true;
    for (const [hash, entry] of this.#hashes) if (now >= entry.usedUntil) this.#hashes.delete(hash);
    return this.#hashes.size < this.capacity;
  }

  #evict(now: number): void {
    for (const [key, entry] of this.#pending) if (now >= entry.expiresAt) this.#pending.delete(key);
    if (this.#pending.size >= this.capacity) {
      const oldest = this.#pending.keys().next();
      if (oldest.done !== true) this.#pending.delete(oldest.value);
    }
  }
}
