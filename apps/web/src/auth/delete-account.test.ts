import { accountDeletionChallenge, accountDeletionHash } from '@remote-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteAccount } from './delete-account.js';
import { OfflineError, RelayError } from './relay-api.js';
import type { RelayApi } from './relay-api.js';
import { fakeRelay, mockCredentials, userCancelled } from './test-credentials.js';
import type { MockedCredentials } from './test-credentials.js';

const USER = 'b6c1d2e3-4f5a-4b6c-8d7e-9f0a1b2c3d4e';

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
async function honestRelay(overrides: Partial<RelayApi> = {}) {
  const hash = await accountDeletionHash(USER);
  const challenge = await accountDeletionChallenge(USER);
  const decisionChallenge = vi.fn<RelayApi['decisionChallenge']>(() =>
    Promise.resolve({ challenge, rpId: 'localhost', userVerification: 'preferred' }),
  );
  const decisionVerify = vi.fn<RelayApi['decisionVerify']>(() =>
    Promise.resolve({ decisionHash: hash, verifiedUntil: 0 }),
  );
  const remove = vi.fn<RelayApi['deleteAccount']>(() => Promise.resolve());
  return {
    hash,
    challenge,
    api: fakeRelay({ decisionChallenge, decisionVerify, deleteAccount: remove, ...overrides }),
    decisionChallenge,
    decisionVerify,
    remove,
  };
}

let credentials: MockedCredentials;
beforeEach(() => {
  credentials = mockCredentials();
});
afterEach(() => {
  credentials.restore();
});

describe('deleteAccount', () => {
  it('signs the deletion hash with user verification required, then deletes', async () => {
    const relay = await honestRelay();
    await expect(deleteAccount(USER, relay.api)).resolves.toEqual({ ok: true });
    expect(relay.decisionChallenge).toHaveBeenCalledWith(relay.hash);
    const publicKey = credentials.get.mock.calls[0]?.[0].publicKey;
    expect(publicKey?.userVerification).toBe('required');
    expect(base64url(publicKey?.challenge as ArrayBuffer)).toBe(relay.challenge);
    expect(relay.remove).toHaveBeenCalledOnce();
  });

  it('never signs a challenge that is not this account deletion', async () => {
    const other = await accountDeletionChallenge('00000000-0000-4000-8000-000000000000');
    const relay = await honestRelay({
      decisionChallenge: () => Promise.resolve({ challenge: other }),
    });
    await expect(deleteAccount(USER, relay.api)).resolves.toEqual({
      ok: false,
      failure: 'challenge_mismatch',
    });
    expect(credentials.get).not.toHaveBeenCalled();
    expect(relay.remove).not.toHaveBeenCalled();
  });

  it('refuses a verification for another hash', async () => {
    const relay = await honestRelay({
      decisionVerify: () => Promise.resolve({ decisionHash: '0'.repeat(64), verifiedUntil: 0 }),
    });
    await expect(deleteAccount(USER, relay.api)).resolves.toEqual({
      ok: false,
      failure: 'challenge_mismatch',
    });
    expect(relay.remove).not.toHaveBeenCalled();
  });

  it('reports a dismissed sheet as cancelled and deletes nothing', async () => {
    credentials.get.mockRejectedValueOnce(userCancelled());
    const relay = await honestRelay();
    await expect(deleteAccount(USER, relay.api)).resolves.toEqual({
      ok: false,
      failure: 'cancelled',
    });
    expect(relay.decisionVerify).not.toHaveBeenCalled();
    expect(relay.remove).not.toHaveBeenCalled();
  });

  it.each([
    [new OfflineError(), 'offline'],
    [new RelayError(403, 'not_verified'), { relay: 'not_verified' }],
  ])('maps a relay failure %s', async (error, failure) => {
    const relay = await honestRelay({ deleteAccount: () => Promise.reject(error) });
    await expect(deleteAccount(USER, relay.api)).resolves.toEqual({ ok: false, failure });
  });
});
