/**
 * What an outstanding WebAuthn challenge stands for. Account ceremonies (D8) and
 * decision step-up (D7) share one shape so one store serves both.
 */
export type PendingChallenge =
  | {
      readonly kind: 'register';
      readonly inviteId: string;
      readonly webauthnUserId: string;
      readonly displayName: string | null;
    }
  | { readonly kind: 'login' }
  | { readonly kind: 'recovery'; readonly userId: string; readonly recoveryCodeId: string }
  | {
      readonly kind: 'decision';
      readonly userId: string;
      readonly deviceId: string;
      /** Hex, as the phone sent it. */
      readonly decisionHash: string;
    };

export interface VerifiedDecision {
  readonly userId: string;
  readonly deviceId: string;
  /** Hex. */
  readonly decisionHash: string;
  /** End of the replay window: the hash is never verified again before it. */
  readonly usedUntil: number;
  /** End of the admission window for this phone's command. */
  readonly verifiedUntil: number;
}

/**
 * Single-use challenges and verified decision hashes (D7, D8). In memory with one
 * replica (`core/memory-challenge-ledger.ts`); in Postgres when replicas share devices
 * (ADR 0016), because a phone's HTTP calls can land on any replica. Holds ids, hashes
 * and expiry times only, never a payload (I3). Every method takes the Clock's `now`.
 */
export interface ChallengeLedger {
  /** Stores a challenge until `expiresAt`. */
  put(key: string, pending: PendingChallenge, expiresAt: number, now: number): Promise<void>;
  /** The live challenge under `key`, removed; `undefined` if unknown, used or expired. */
  take(key: string, now: number): Promise<PendingChallenge | undefined>;
  /**
   * `used` while the hash is inside its replay window; `busy` when an in-memory ledger
   * is full of live hashes; otherwise `free`.
   */
  usage(decisionHash: string, now: number): Promise<'free' | 'used' | 'busy'>;
  /** Records a verification; `false` if the hash is already used (a concurrent verify won). */
  markVerified(verified: VerifiedDecision, now: number): Promise<boolean>;
  /** Whether this phone verified this hash and its admission window is open. */
  isVerified(userId: string, deviceId: string, decisionHash: string, now: number): Promise<boolean>;
  /** Like {@link isVerified}, and closes the admission window: a hash is spent once. */
  consume(userId: string, deviceId: string, decisionHash: string, now: number): Promise<boolean>;
}
