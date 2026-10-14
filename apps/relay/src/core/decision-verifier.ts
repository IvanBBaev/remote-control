import { fromHex } from '@remote-control/crypto';
import { toBase64Url, type Clock, type Envelope } from '@remote-control/protocol';

import type { AccountStore } from '../ports/account-store.js';
import type { ChallengeLedger } from '../ports/challenge-ledger.js';
import type { DeviceIdentity } from '../ports/device-directory.js';
import type { CommandGate } from '../ports/relay-seams.js';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
  WebAuthnPort,
} from '../ports/webauthn.js';
import { CHALLENGE_TTL_MS } from './account-service.js';
import { MemoryChallengeLedger } from './memory-challenge-ledger.js';

const MINUTE = 60_000;

/** A verified decision hash is never verified again within this window (02 §5.4, D7). */
export const USED_CHALLENGE_TTL_MS = 10 * MINUTE;
/** How long a verified hash admits its `cls: command` envelope: the decision's validity (D7). */
export const VERIFIED_TTL_MS = 5 * MINUTE;
export type VerifyFailure =
  'unknown_challenge' | 'replayed' | 'unknown_credential' | 'verification_failed';

export interface DecisionVerifierDeps {
  readonly store: Pick<AccountStore, 'findPasskey' | 'recordPasskeyUse'>;
  readonly webauthn: Pick<
    WebAuthnPort,
    'authenticationOptions' | 'challengeOf' | 'verifyAuthentication'
  >;
  readonly clock: Clock;
  /** Shared across replicas (ADR 0016); a fresh in-memory ledger by default. */
  readonly ledger?: ChallengeLedger;
  /** Bound of each table of the default in-memory ledger. */
  readonly capacity?: number;
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
 * Challenges and verified hashes live in a {@link ChallengeLedger}: in memory with one
 * replica (D15), in Postgres when replicas share devices (ADR 0016).
 */
export class DecisionVerifier implements CommandGate {
  readonly #ledger: ChallengeLedger;

  constructor(private readonly deps: DecisionVerifierDeps) {
    this.#ledger = deps.ledger ?? new MemoryChallengeLedger(deps.capacity);
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
    const hash = toHex(bytes);
    const now = this.deps.clock.now();
    const usage = await this.#ledger.usage(hash, now);
    if (usage === 'used') return { ok: false, reason: 'replayed' };
    if (usage === 'busy') return { ok: false, reason: 'busy' };
    await this.#ledger.put(
      this.#pendingKey(phone, toBase64Url(bytes)),
      { kind: 'decision', userId: phone.userId, deviceId: phone.deviceId, decisionHash: hash },
      now + CHALLENGE_TTL_MS,
      now,
    );
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
    const hash = hashOfChallenge(challenge);
    if (hash !== null && (await this.#ledger.usage(hash, this.deps.clock.now())) === 'used') {
      return { ok: false, reason: 'replayed' };
    }
    const pending = await this.#ledger.take(
      this.#pendingKey(phone, challenge),
      this.deps.clock.now(),
    );
    if (pending?.kind !== 'decision') return { ok: false, reason: 'unknown_challenge' };
    const passkey = await this.deps.store.findPasskey(response.id);
    if (passkey === undefined || passkey.userId !== phone.userId) {
      return { ok: false, reason: 'unknown_credential' };
    }
    if (response.response.userHandle !== passkey.webauthnUserId) {
      return { ok: false, reason: 'verification_failed' };
    }
    const verified = await this.deps.webauthn.verifyAuthentication(response, challenge, passkey);
    if (verified === null) return { ok: false, reason: 'verification_failed' };
    // The ledger refuses a hash already used: a concurrent verify of the same assertion won.
    const now = this.deps.clock.now();
    const verifiedUntil = now + VERIFIED_TTL_MS;
    const won = await this.#ledger.markVerified(
      {
        userId: phone.userId,
        deviceId: phone.deviceId,
        decisionHash: pending.decisionHash,
        usedUntil: now + USED_CHALLENGE_TTL_MS,
        verifiedUntil,
      },
      now,
    );
    if (!won) return { ok: false, reason: 'replayed' };
    await this.deps.store.recordPasskeyUse(passkey.id, verified.newCounter, verified.backedUp, now);
    return { ok: true, decisionHash: pending.decisionHash, verifiedUntil };
  }

  admit(envelope: Envelope, sender: DeviceIdentity): boolean | Promise<boolean> {
    if (envelope.decisionHash === undefined) return true;
    return this.#ledger.isVerified(
      sender.userId,
      sender.deviceId,
      normalized(envelope.decisionHash),
      this.deps.clock.now(),
    );
  }

  /**
   * Spends a hash this phone verified, for an HTTP action that needs UV (account
   * deletion, M1-10); `false` if it was never verified or its window passed.
   */
  consume(phone: DeviceIdentity, hash: string): Promise<boolean> {
    return this.#ledger.consume(
      phone.userId,
      phone.deviceId,
      normalized(hash),
      this.deps.clock.now(),
    );
  }

  #pendingKey(phone: DeviceIdentity, challenge: string): string {
    return `decision:${phone.userId}:${phone.deviceId}:${challenge}`;
  }
}

/** Lower-case hex, so the same hash always names the same ledger entry. */
function normalized(hash: string): string {
  return hash.toLowerCase();
}

/** The hex decision hash behind a base64url challenge; `null` if it is not 32 bytes. */
function hashOfChallenge(challenge: string): string | null {
  const bytes = Buffer.from(challenge, 'base64url');
  return bytes.length === 32 ? toHex(bytes) : null;
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
