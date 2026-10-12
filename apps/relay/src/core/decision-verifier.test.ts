import { toBase64Url, type Envelope } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import type { StoredPasskey } from '../ports/account-store.js';
import type { AuthenticationResponseJSON } from '../ports/webauthn.js';
import { createFakeTime } from '../testing/fake-time.js';
import { DecisionVerifier, USED_CHALLENGE_TTL_MS, VERIFIED_TTL_MS } from './decision-verifier.js';

const PHONE = { userId: 'u1', deviceId: 'p1', kind: 'phone' as const };
const PASSKEY = { id: 'cred', userId: 'u1', webauthnUserId: 'handle' } as StoredPasskey;

const hashOf = (n: number) => n.toString(16).padStart(64, '0');
const challengeOf = (hash: string) => toBase64Url(Buffer.from(hash, 'hex'));

/** A response whose `clientDataJSON` is read back as its challenge by the fake port. */
const response = (hash: string): AuthenticationResponseJSON =>
  ({
    id: 'cred',
    response: { clientDataJSON: challengeOf(hash), userHandle: 'handle' },
  }) as AuthenticationResponseJSON;

const command = (decisionHash?: string) => ({ decisionHash }) as Envelope;

function harness(capacity?: number) {
  const time = createFakeTime();
  const verifyAuthentication = () => Promise.resolve({ newCounter: 1, backedUp: true });
  const verifier = new DecisionVerifier({
    clock: time.clock,
    store: {
      findPasskey: () => Promise.resolve(PASSKEY),
      recordPasskeyUse: () => Promise.resolve(),
    },
    webauthn: {
      authenticationOptions: (challenge) => Promise.resolve({ challenge: toBase64Url(challenge) }),
      challengeOf: (r) => r.response.clientDataJSON,
      verifyAuthentication,
    },
    ...(capacity === undefined ? {} : { capacity }),
  });
  return { time, verifier };
}

describe('DecisionVerifier', () => {
  it('admits a verified hash for 5 minutes, and a command without a hash always', async () => {
    const { time, verifier } = harness();
    const hash = hashOf(1);
    expect(verifier.admit(command(), PHONE)).toBe(true);
    expect(verifier.admit(command(hash), PHONE)).toBe(false);

    await verifier.challenge(PHONE, hash);
    expect(await verifier.verify(PHONE, response(hash))).toEqual({
      ok: true,
      decisionHash: hash,
      verifiedUntil: time.clock.now() + VERIFIED_TTL_MS,
    });
    expect(verifier.admit(command(hash), PHONE)).toBe(true);
    expect(verifier.admit(command(hash), { ...PHONE, deviceId: 'p2' })).toBe(false);
    time.advance(VERIFIED_TTL_MS);
    expect(verifier.admit(command(hash), PHONE)).toBe(false);
  });

  it('refuses a used hash for 10 minutes', async () => {
    const { time, verifier } = harness();
    const hash = hashOf(2);
    await verifier.challenge(PHONE, hash);
    await verifier.verify(PHONE, response(hash));
    expect(await verifier.challenge(PHONE, hash)).toEqual({ ok: false, reason: 'replayed' });
    time.advance(USED_CHALLENGE_TTL_MS);
    expect((await verifier.challenge(PHONE, hash)).ok).toBe(true);
  });

  it('answers busy when the used set is full of live entries, and frees expired ones', async () => {
    const { time, verifier } = harness(1);
    await verifier.challenge(PHONE, hashOf(3));
    await verifier.verify(PHONE, response(hashOf(3)));
    expect(await verifier.challenge(PHONE, hashOf(4))).toEqual({ ok: false, reason: 'busy' });
    time.advance(USED_CHALLENGE_TTL_MS);
    expect((await verifier.challenge(PHONE, hashOf(4))).ok).toBe(true);
  });

  it('evicts the oldest verified hash when that table is full', async () => {
    const { time, verifier } = harness(1);
    await verifier.challenge(PHONE, hashOf(5));
    await verifier.verify(PHONE, response(hashOf(5)));
    time.advance(USED_CHALLENGE_TTL_MS);
    // The used entry of hash 5 is expired (room), the verified one too but still present.
    await verifier.challenge(PHONE, hashOf(6));
    await verifier.verify(PHONE, response(hashOf(6)));
    expect(verifier.admit(command(hashOf(6)), PHONE)).toBe(true);
    expect(verifier.admit(command(hashOf(5)), PHONE)).toBe(false);
  });

  it('lets only one of two concurrent verifications of the same assertion win', async () => {
    const { verifier } = harness();
    const hash = hashOf(7);
    const tablet = { ...PHONE, deviceId: 'p2' };
    await verifier.challenge(PHONE, hash);
    await verifier.challenge(tablet, hash);
    const [first, second] = await Promise.all([
      verifier.verify(PHONE, response(hash)),
      verifier.verify(tablet, response(hash)),
    ]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect(first.ok ? second : first).toEqual({ ok: false, reason: 'replayed' });
  });
});
