import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthStore, isSignedIn, noSessionHint, storageSessionHint } from './auth-store.js';
import type { SessionHint } from './auth-store.js';
import { OfflineError, RelayError } from './relay-api.js';
import type { RelayApi } from './relay-api.js';
import { fakeRelay, mockCredentials, userCancelled } from './test-credentials.js';
import type { MockedCredentials } from './test-credentials.js';

const CREATION = {
  challenge: 'Y2hhbGxlbmdl',
  rp: { id: 'localhost', name: 'remote-control' },
  user: { id: 'dXNlci0x', name: 'owner', displayName: 'Owner' },
  pubKeyCredParams: [{ alg: -7, type: 'public-key' as const }],
  authenticatorSelection: { userVerification: 'required' as const },
};
const REQUEST = { challenge: 'bG9naW4', rpId: 'localhost', userVerification: 'required' as const };

function memoryHint(initial: string | null = null): SessionHint & { value: string | null } {
  return {
    value: initial,
    read() {
      return this.value;
    },
    write(userId) {
      this.value = userId;
    },
  };
}

let credentials: MockedCredentials;
beforeEach(() => {
  credentials = mockCredentials();
});
afterEach(() => {
  credentials.restore();
});

describe('register', () => {
  it('creates a passkey with the relay options and holds the recovery code', async () => {
    const registerOptions = vi.fn<RelayApi['registerOptions']>(() => Promise.resolve(CREATION));
    const registerVerify = vi.fn<RelayApi['registerVerify']>(() =>
      Promise.resolve({ userId: 'user-1', recoveryCode: 'ABCD-EFGH', backedUp: true }),
    );
    const hint = memoryHint();
    const store = createAuthStore({ api: fakeRelay({ registerOptions, registerVerify }), hint });

    await expect(
      store.getState().register({ inviteCode: 'INV', displayName: 'Owner' }),
    ).resolves.toEqual({ ok: true });

    expect(registerOptions).toHaveBeenCalledWith({ inviteCode: 'INV', displayName: 'Owner' });
    expect(credentials.create).toHaveBeenCalledOnce();
    expect(registerVerify.mock.calls[0]?.[0]).toMatchObject({ id: 'Y3JlZC0x', type: 'public-key' });
    expect(store.getState()).toMatchObject({
      status: 'signed-in',
      userId: 'user-1',
      recoveryCode: 'ABCD-EFGH',
    });
    expect(isSignedIn(store.getState())).toBe(false);
    expect(hint.value).toBe('user-1');

    store.getState().confirmRecoverySaved();
    expect(isSignedIn(store.getState())).toBe(true);
  });

  it('omits an absent display name', async () => {
    const registerOptions = vi.fn<RelayApi['registerOptions']>(() =>
      Promise.reject(new RelayError(403, 'invalid_invite')),
    );
    const store = createAuthStore({ api: fakeRelay({ registerOptions }) });
    await expect(store.getState().register({ inviteCode: 'BAD' })).resolves.toEqual({
      ok: false,
      failure: { relay: 'invalid_invite' },
    });
    expect(registerOptions).toHaveBeenCalledWith({ inviteCode: 'BAD' });
    expect(credentials.create).not.toHaveBeenCalled();
  });

  it('reports a dismissed sheet as cancelled and stays signed out', async () => {
    credentials.create.mockRejectedValueOnce(userCancelled());
    const store = createAuthStore({
      api: fakeRelay({ registerOptions: () => Promise.resolve(CREATION) }),
      initial: { status: 'signed-out' },
    });
    await expect(store.getState().register({ inviteCode: 'INV' })).resolves.toEqual({
      ok: false,
      failure: 'cancelled',
    });
    expect(store.getState().status).toBe('signed-out');
  });
});

describe('login', () => {
  const api = () =>
    fakeRelay({
      loginOptions: () => Promise.resolve(REQUEST),
      loginVerify: () => Promise.resolve({ userId: 'user-2' }),
    });

  it('signs in from the passkey sheet', async () => {
    const store = createAuthStore({ api: api() });
    await expect(store.getState().login()).resolves.toEqual({ ok: true });
    expect(credentials.get.mock.calls[0]?.[0].mediation).toBeUndefined();
    expect(store.getState()).toMatchObject({ status: 'signed-in', userId: 'user-2' });
    expect(isSignedIn(store.getState())).toBe(true);
  });

  it('signs in through conditional mediation for autofill', async () => {
    const field = document.createElement('input');
    field.autocomplete = 'username webauthn';
    document.body.append(field);
    const store = createAuthStore({ api: api() });
    await expect(store.getState().loginWithAutofill()).resolves.toEqual({ ok: true });
    expect(credentials.get.mock.calls[0]?.[0].mediation).toBe('conditional');
    field.remove();
  });

  it('fails autofill without a webauthn autocomplete field', async () => {
    const store = createAuthStore({ api: api() });
    await expect(store.getState().loginWithAutofill()).resolves.toEqual({
      ok: false,
      failure: 'failed',
    });
    expect(credentials.get).not.toHaveBeenCalled();
  });

  it('maps an unknown credential to its relay reason', async () => {
    const store = createAuthStore({
      api: fakeRelay({
        loginOptions: () => Promise.resolve(REQUEST),
        loginVerify: () => Promise.reject(new RelayError(401, 'unknown_credential')),
      }),
    });
    await expect(store.getState().login()).resolves.toEqual({
      ok: false,
      failure: { relay: 'unknown_credential' },
    });
  });
});

describe('checkSession', () => {
  it('signs in from a live session cookie', async () => {
    const hint = memoryHint();
    const store = createAuthStore({
      api: fakeRelay({ session: () => Promise.resolve({ userId: 'user-1' }) }),
      hint,
    });
    await store.getState().checkSession();
    expect(store.getState()).toMatchObject({ status: 'signed-in', userId: 'user-1' });
    expect(hint.value).toBe('user-1');
  });

  it('signs out and forgets the hint when there is no session', async () => {
    const hint = memoryHint('user-1');
    const store = createAuthStore({
      api: fakeRelay({ session: () => Promise.resolve(null) }),
      hint,
    });
    await store.getState().checkSession();
    expect(store.getState().status).toBe('signed-out');
    expect(hint.value).toBeNull();
  });

  it.each([
    ['user-1', { status: 'signed-in', userId: 'user-1' }],
    [null, { status: 'signed-out', userId: null }],
  ])('trusts the hint %s while offline', async (hinted, expected) => {
    const store = createAuthStore({
      api: fakeRelay({ session: () => Promise.reject(new OfflineError()) }),
      hint: memoryHint(hinted),
    });
    await store.getState().checkSession();
    expect(store.getState()).toMatchObject(expected);
  });

  it('keeps the state on any other failure', async () => {
    const store = createAuthStore({
      api: fakeRelay({ session: () => Promise.reject(new RelayError(503, 'busy')) }),
    });
    await store.getState().checkSession();
    expect(store.getState().status).toBe('unknown');
  });
});

describe('signOut', () => {
  it('signs out even when the relay call fails', async () => {
    const hint = memoryHint('user-1');
    const store = createAuthStore({
      api: fakeRelay(),
      hint,
      initial: { status: 'signed-in', userId: 'user-1' },
    });
    await expect(store.getState().signOut()).rejects.toThrow('fakeRelay.logout');
    expect(store.getState()).toMatchObject({ status: 'signed-out', userId: null });
    expect(hint.value).toBeNull();
  });
});

describe('storageSessionHint', () => {
  it('stores, reads and clears the last user', () => {
    const hint = storageSessionHint(() => window.localStorage);
    hint.write('user-9');
    expect(hint.read()).toBe('user-9');
    hint.write(null);
    expect(hint.read()).toBeNull();
  });

  it('is a no-op without storage', () => {
    const hint = storageSessionHint(() => undefined);
    hint.write('user-9');
    expect(hint.read()).toBeNull();
  });

  it('swallows storage that throws', () => {
    const hint = storageSessionHint(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(() => {
      hint.write('user-9');
    }).not.toThrow();
    expect(hint.read()).toBeNull();
  });

  it('noSessionHint remembers nothing', () => {
    noSessionHint.write('user-9');
    expect(noSessionHint.read()).toBeNull();
  });
});
