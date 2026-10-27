import type { CanonicalDecision } from '@remote-control/protocol';
import { beforeAll, describe, expect, it } from 'vitest';

import { createTestDeviceKey, type TestDeviceKey } from '../testing/test-device-key.js';
import { checkDeviceSignature } from './device-signature-check.js';

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

let key: TestDeviceKey;
let other: TestDeviceKey;

beforeAll(async () => {
  key = await createTestDeviceKey();
  other = await createTestDeviceKey();
});

describe('checkDeviceSignature', () => {
  it('accepts a signature over the decision by the paired device key', async () => {
    const signature = await key.sign(decision);
    expect(await checkDeviceSignature({ signature, decision, deviceKey: key.paired })).toEqual({
      ok: true,
    });
  });

  it('refuses a signature by another key', async () => {
    const signature = await other.sign(decision);
    expect(await checkDeviceSignature({ signature, decision, deviceKey: key.paired })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a signature over another decision (wrong hash)', async () => {
    const signature = await key.sign({ ...decision, kind: 'deny' });
    expect(await checkDeviceSignature({ signature, decision, deviceKey: key.paired })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a key the phone did not declare gated by user verification', async () => {
    const unverified = await createTestDeviceKey(false);
    const signature = await unverified.sign(decision);
    expect(
      await checkDeviceSignature({ signature, decision, deviceKey: unverified.paired }),
    ).toEqual({ ok: false, reason: 'not_user_verified' });
  });

  it('refuses a missing signature or a peer without a device key', async () => {
    const signature = await key.sign(decision);
    expect(
      await checkDeviceSignature({ signature: undefined, decision, deviceKey: key.paired }),
    ).toEqual({ ok: false, reason: 'missing' });
    expect(await checkDeviceSignature({ signature, decision, deviceKey: undefined })).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('refuses a malformed signature or key', async () => {
    const signature = await key.sign(decision);
    expect(
      await checkDeviceSignature({ signature: 'a+b', decision, deviceKey: key.paired }),
    ).toEqual({ ok: false, reason: 'malformed' });
    expect(
      await checkDeviceSignature({
        signature,
        decision,
        deviceKey: { publicKey: '*', userVerified: true },
      }),
    ).toEqual({ ok: false, reason: 'malformed' });
    expect(
      await checkDeviceSignature({ signature: 'AAAA', decision, deviceKey: key.paired }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });
});
