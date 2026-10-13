import { fromHex } from '@remote-control/crypto';
import { toBase64Url, type Clock, type Envelope } from '@remote-control/protocol';

import type { AccountStore } from '../ports/account-store.js';
import type { DeviceIdentity } from '../ports/device-directory.js';
import type { CommandGate } from '../ports/relay-seams.js';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
  WebAuthnPort,
} from '../ports/webauthn.js';
import { CHALLENGE_TTL_MS } from './account-service.js';
import { ChallengeStore } from './challenge-store.js';

const MINUTE = 60_000;

/** A verified decision hash is never verified again within this window (02 §5.4, D7). */
export const USED_CHALLENGE_TTL_MS = 10 * MINUTE;
/** How long a verified hash admits its `cls: command` envelope: the decision's validity (D7). */
export const VERIFIED_TTL_MS = 5 * MINUTE;
const DEFAULT_CAPACITY = 10_000;

export type VerifyFailure =
  'unknown_challenge' | 'replayed' | 'unknown_credential' | 'verification_failed';

export interface DecisionVerifierDeps {
  readonly store: Pick<AccountStore, 'findPasskey' | 'recordPasskeyUse'>;
  readonly webauthn: Pick<
    WebAuthnPort,
    'authenticationOptions' | 'challengeOf' | 'verifyAuthentication'
  >;
  readonly clock: Clock;
  /** Bound of each in-memory table (pending, used, verified). */
  readonly capacity?: number;
}

interface PendingDecision {
  readonly userId: string;
  readonly decisionHash: string;
}

/**
 * Step-up user verification of a decision (D7, 02 §5.4). The phone asks for WebAuthn
 * options whose challenge is the decision hash, signs it with UV, and the relay checks
 * the assertion and remembers `verified(user, phone, hash)`. As the relay's
 * {@link CommandGate} it then forwards a `cls: command` envelope that names a
 * `decisionHash` only when that phone verified that hash. The relay checks; it never
 * decides (I4): the agent still runs every D7 check and decide-once.
 *
 * Commands without a `decisionHash` (deny, stop) pass: they need no assertion (02 §5.4)
 * and the agent refuses an assertion-requiring kind without one.
 *
 * In memory, which is enough for one replica (D15); a restart only forces another tap.
 */
export class DecisionVerifier implements CommandGate {
  readonly #pending: ChallengeStore<PendingDecision>;
  /** base64url challenge → end of its replay window. */
  readonly #used = new Map<string, number>();
  /** `user:device:hash` → end of its admission window. */
  readonly #verified = new Map<string, number>();
  readonly #capacity: number;

  constructor(private readonly deps: DecisionVerifierDeps) {
    this.#capacity = deps.capacity ?? DEFAULT_CAPACITY;
    this.#pending = new ChallengeStore(deps.clock, CHALLENGE_TTL_MS, this.#capacity);
  }

  /** WebAuthn request options whose challenge is the 32 bytes of `decisionHash` (hex). */
  async challenge(
    phone: DeviceIdentity,
    decisionHash: string,
  ): Promise<
    | { readonly ok: true; readonly options: PublicKeyCredentialRequestOptionsJSON }
    | { readonly ok: false; readonly reason: 'replayed' | 'busy' }
  > {
    const bytes = fromHex(decisionHash);
    const challenge = toBase64Url(bytes);
    const now = this.deps.clock.now();
    if (this.#isUsed(challenge, now)) return { ok: false, reason: 'replayed' };
    if (!this.#room(this.#used, now)) return { ok: false, reason: 'busy' };
    this.#pending.put(this.#pendingKey(phone, challenge), { userId: phone.userId, decisionHash });
    return { ok: true, options: await this.deps.webauthn.authenticationOptions(bytes) };
  }

  /** Checks the UV assertion over a decision hash this phone asked for; single-use. */
  async verify(
    phone: DeviceIdentity,
    response: AuthenticationResponseJSON,
  ): Promise<
    | { readonly ok: true; readonly decisionHash: string; readonly verifiedUntil: number }
    | { readonly ok: false; readonly reason: VerifyFailure }
  > {
    const challenge = this.deps.webauthn.challengeOf(response);
    if (challenge === null) return { ok: false, reason: 'unknown_challenge' };
    if (this.#isUsed(challenge, this.deps.clock.now())) return { ok: false, reason: 'replayed' };
    const pending = this.#pending.take(this.#pendingKey(phone, challenge));
    if (pending === undefined) return { ok: false, reason: 'unknown_challenge' };
    const passkey = await this.deps.store.findPasskey(response.id);
    if (passkey === undefined || passkey.userId !== phone.userId) {
      return { ok: false, reason: 'unknown_credential' };
    }
    if (response.response.userHandle !== passkey.webauthnUserId) {
      return { ok: false, reason: 'verification_failed' };
    }
    const verified = await this.deps.webauthn.verifyAuthentication(response, challenge, passkey);
    if (verified === null) return { ok: false, reason: 'verification_failed' };
    // Re-check after the awaits: a concurrent verify of the same assertion lost the race.
    const now = this.deps.clock.now();
    if (this.#isUsed(challenge, now)) return { ok: false, reason: 'replayed' };
    this.#used.set(challenge, now + USED_CHALLENGE_TTL_MS);
    const verifiedUntil = now + VERIFIED_TTL_MS;
    if (!this.#room(this.#verified, now)) this.#dropOldest(this.#verified);
    this.#verified.set(this.#verifiedKey(phone, pending.decisionHash), verifiedUntil);
    await this.deps.store.recordPasskeyUse(passkey.id, verified.newCounter, verified.backedUp, now);
    return { ok: true, decisionHash: pending.decisionHash, verifiedUntil };
  }

  admit(envelope: Envelope, sender: DeviceIdentity): boolean {
    if (envelope.decisionHash === undefined) return true;
    const until = this.#verified.get(this.#verifiedKey(sender, envelope.decisionHash));
    return until !== undefined && this.deps.clock.now() < until;
  }

  /**
   * Spends a hash this phone verified, for an HTTP action that needs UV (account
   * deletion, M1-10); `false` if it was never verified or its window passed.
   */
  consume(phone: DeviceIdentity, hash: string): boolean {
    const key = this.#verifiedKey(phone, hash);
    const until = this.#verified.get(key);
    this.#verified.delete(key);
    return until !== undefined && this.deps.clock.now() < until;
  }

  #isUsed(challenge: string, now: number): boolean {
    const until = this.#used.get(challenge);
    return until !== undefined && now < until;
  }

  /** Drops expired entries when the table is full; `false` if it is still full. */
  #room(table: Map<string, number>, now: number): boolean {
    if (table.size < this.#capacity) return true;
    for (const [key, until] of table) if (now >= until) table.delete(key);
    return table.size < this.#capacity;
  }

  #dropOldest(table: Map<string, number>): void {
    const oldest = table.keys().next();
    if (oldest.done !== true) table.delete(oldest.value);
  }

  #pendingKey(phone: DeviceIdentity, challenge: string): string {
    return `${phone.userId}:${phone.deviceId}:${challenge}`;
  }

  #verifiedKey(device: DeviceIdentity, decisionHash: string): string {
    return `${device.userId}:${device.deviceId}:${decisionHash}`;
  }
}
