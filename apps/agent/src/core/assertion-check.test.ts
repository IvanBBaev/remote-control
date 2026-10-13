import type { CanonicalDecision } from '@remote-control/protocol';
import { beforeAll, describe, expect, it } from 'vitest';

import { createTestPasskey, type TestPasskey } from '../testing/test-passkey.js';
import type { PeerPasskey } from '../ports/key-store.js';
import { checkAssertion } from './assertion-check.js';

const NOW = 1_760_000_000;

const decision: CanonicalDecision = {
  v: 1,
  kind: 'allow',
  request_id: '00000000-0000-4000-8000-000000000001',
  request_hash: 'a'.repeat(64),
  payload: null,
  issued_at: NOW,
  expires_at: NOW + 300,
  phone_device_id: '0190a1b2-0000-7000-8000-0000000000a1',
  agent_device_id: '0190a1b2-0000-7000-8000-0000000000b2',
};

let passkey: TestPasskey;
let other: TestPasskey;
let known: PeerPasskey;

beforeAll(async () => {
  passkey = await createTestPasskey();
  other = await createTestPasskey();
  known = { ...passkey.paired, counter: 0 };
});

/** Flips one bit of a base64url field's decoded bytes. */
function flip(text: string, index: number): string {
  const bytes = Uint8Array.from(Buffer.from(text, 'base64url'));
  bytes[index < 0 ? bytes.length + index : index]! ^= 0x01;
  return Buffer.from(bytes).toString('base64url');
}

describe('checkAssertion', () => {
  it('accepts a UV assertion over the decision with a paired passkey', async () => {
    const assertion = await passkey.assert(decision, { counter: 7 });
    expect(await checkAssertion({ assertion, decision, passkeys: [known] })).toEqual({
      ok: true,
      credentialId: passkey.paired.id,
      counter: 7,
    });
  });

  it('accepts a passkey that never counts (synced passkeys keep 0)', async () => {
    const assertion = await passkey.assert(decision, { counter: 0 });
    expect(await checkAssertion({ assertion, decision, passkeys: [known] })).toMatchObject({
      ok: true,
      counter: 0,
    });
  });

  it('refuses a missing assertion and an unknown credential', async () => {
    expect(await checkAssertion({ assertion: undefined, decision, passkeys: [known] })).toEqual({
      ok: false,
      reason: 'missing',
    });
    const assertion = await other.assert(decision);
    expect(await checkAssertion({ assertion, decision, passkeys: [known] })).toEqual({
      ok: false,
      reason: 'unknown_credential',
    });
  });

  it('refuses a signature from another key under the paired credential id', async () => {
    const assertion = {
      ...(await other.assert(decision)),
      credentialId: passkey.paired.id,
    };
    expect(await checkAssertion({ assertion, decision, passkeys: [known] })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it.each([
    ['signature', -1],
    ['signature', 10],
    ['authenticatorData', 36],
  ] as const)('refuses a tampered %s (byte %d)', async (field, index) => {
    const genuine = await passkey.assert(decision);
    const assertion = { ...genuine, [field]: flip(genuine[field], index) };
    const result = await checkAssertion({ assertion, decision, passkeys: [known] });
    expect(result.ok).toBe(false);
  });

  it('refuses an assertion over another decision', async () => {
    const assertion = await passkey.assert(decision);
    const other = { ...decision, kind: 'deny' as const };
    expect(await checkAssertion({ assertion, decision: other, passkeys: [known] })).toEqual({
      ok: false,
      reason: 'wrong_challenge',
    });
  });

  it.each([
    ['wrong_type', { type: 'webauthn.create' }],
    ['wrong_challenge', { challenge: 'AAAA' }],
    ['wrong_rp', { rpId: 'evil.example' }],
    ['not_user_verified', { userVerified: false }],
  ] as const)('refuses a signed assertion with %s', async (reason, overrides) => {
    const assertion = await passkey.assert(decision, overrides);
    expect(await checkAssertion({ assertion, decision, passkeys: [known] })).toEqual({
      ok: false,
      reason,
    });
  });

  it('refuses a counter that did not move forward', async () => {
    const seen = { ...known, counter: 5 };
    for (const counter of [5, 4, 0]) {
      const assertion = await passkey.assert(decision, { counter });
      expect(await checkAssertion({ assertion, decision, passkeys: [seen] })).toEqual({
        ok: false,
        reason: 'counter_replay',
      });
    }
  });

  it('refuses malformed fields', async () => {
    const genuine = await passkey.assert(decision);
    for (const assertion of [
      { ...genuine, authenticatorData: 'AAAA' },
      { ...genuine, clientDataJSON: 'bm90IGpzb24' },
      { ...genuine, clientDataJSON: 'bnVsbA' },
      { ...genuine, signature: 'A' },
    ]) {
      expect(await checkAssertion({ assertion, decision, passkeys: [known] })).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
    const badKey = { ...known, publicKey: 'AAAA' };
    expect(
      await checkAssertion({ assertion: genuine, decision, passkeys: [badKey] }),
    ).toMatchObject({ ok: false });
  });
});
