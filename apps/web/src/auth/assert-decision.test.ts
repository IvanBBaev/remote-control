import { DECISION_TTL_SECONDS, decisionChallenge, decisionHash } from '@remote-control/protocol';
import type { CanonicalDecision } from '@remote-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertDecision } from './assert-decision.js';
import { OfflineError, RelayError } from './relay-api.js';
import type { RelayApi } from './relay-api.js';
import {
  FAKE_CREDENTIAL_ID,
  fakeRelay,
  mockCredentials,
  userCancelled,
} from './test-credentials.js';
import type { MockedCredentials } from './test-credentials.js';

const ISSUED = 1_791_763_200;

function decision(kind: CanonicalDecision['kind']): CanonicalDecision {
  return {
    v: 1,
    request_id: '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b',
    request_hash: '4196590ec41b976c1c2f586f398945a01bf0e4c11b18bab7809211a4c8025bcf',
    issued_at: ISSUED,
    expires_at: ISSUED + DECISION_TTL_SECONDS,
    phone_device_id: '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
    agent_device_id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    kind,
    payload: null,
  };
}

const base64url = (bytes: ArrayBuffer | ArrayBufferView): string => {
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return btoa(String.fromCharCode(...view))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
};

/** A relay that answers as the real one: challenge = base64url(hash bytes). */
async function honestRelay(d: CanonicalDecision, overrides: Partial<RelayApi> = {}) {
  const hash = await decisionHash(d);
  const challenge = await decisionChallenge(d);
  const decisionChallengeCall = vi.fn<RelayApi['decisionChallenge']>(() =>
    Promise.resolve({ challenge, rpId: 'localhost', userVerification: 'preferred' }),
  );
  const decisionVerify = vi.fn<RelayApi['decisionVerify']>(() =>
    Promise.resolve({ decisionHash: hash, verifiedUntil: (ISSUED + 60) * 1000 }),
  );
  return {
    hash,
    challenge,
    api: fakeRelay({ decisionChallenge: decisionChallengeCall, decisionVerify, ...overrides }),
    decisionChallengeCall,
    decisionVerify,
  };
}

let credentials: MockedCredentials;
beforeEach(() => {
  credentials = mockCredentials();
});
afterEach(() => {
  credentials.restore();
});

describe('assertDecision', () => {
  it.each(['deny', 'terminal'] as const)('%s needs no assertion (D7)', async (kind) => {
    const d = decision(kind);
    await expect(assertDecision(d, fakeRelay())).resolves.toEqual({
      ok: true,
      decisionHash: await decisionHash(d),
      asserted: false,
    });
    expect(credentials.get).not.toHaveBeenCalled();
  });

  it('signs exactly the decision hash with user verification required', async () => {
    const d = decision('allow');
    const relay = await honestRelay(d);
    await expect(assertDecision(d, relay.api)).resolves.toEqual({
      ok: true,
      decisionHash: relay.hash,
      asserted: true,
      // Sealed into the decision so the agent checks it itself (D7 phase 2, M2-03).
      assertion: {
        credentialId: FAKE_CREDENTIAL_ID,
        authenticatorData: 'YXV0aC1kYXRh', // auth-data
        clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0', // {"type":"webauthn.get"}
        signature: 'c2lnbmF0dXJl', // signature
      },
    });
    expect(relay.decisionChallengeCall).toHaveBeenCalledWith(relay.hash);
    const publicKey = credentials.get.mock.calls[0]?.[0].publicKey;
    expect(publicKey?.userVerification).toBe('required');
    expect(base64url(publicKey?.challenge as ArrayBuffer)).toBe(relay.challenge);
    expect(relay.decisionVerify.mock.calls[0]?.[0]).toMatchObject({ id: 'Y3JlZC0x' });
  });

  it('never signs a challenge that is not its own decision (I3)', async () => {
    const d = decision('allow');
    const other = await decisionChallenge(decision('always'));
    const relay = await honestRelay(d, {
      decisionChallenge: () => Promise.resolve({ challenge: other }),
    });
    await expect(assertDecision(d, relay.api)).resolves.toEqual({
      ok: false,
      failure: 'challenge_mismatch',
    });
    expect(credentials.get).not.toHaveBeenCalled();
  });

  it('refuses a verification for another hash', async () => {
    const d = decision('allow');
    const relay = await honestRelay(d, {
      decisionVerify: () => Promise.resolve({ decisionHash: '0'.repeat(64), verifiedUntil: 0 }),
    });
    await expect(assertDecision(d, relay.api)).resolves.toEqual({
      ok: false,
      failure: 'challenge_mismatch',
    });
  });

  it('reports a dismissed sheet as cancelled', async () => {
    credentials.get.mockRejectedValueOnce(userCancelled());
    const d = decision('allow');
    const relay = await honestRelay(d);
    await expect(assertDecision(d, relay.api)).resolves.toEqual({
      ok: false,
      failure: 'cancelled',
    });
    expect(relay.decisionVerify).not.toHaveBeenCalled();
  });

  it.each([
    [new OfflineError(), 'offline'],
    [new RelayError(409, 'replayed'), { relay: 'replayed' }],
    [new RelayError(409, 'no_device'), { relay: 'no_device' }],
  ])('maps a relay failure %s', async (error, failure) => {
    const d = decision('always');
    const relay = await honestRelay(d, { decisionChallenge: () => Promise.reject(error) });
    await expect(assertDecision(d, relay.api)).resolves.toEqual({ ok: false, failure });
  });
});
