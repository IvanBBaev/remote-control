import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthStore } from '../auth/auth-store.js';
import { OfflineError, RelayError } from '../auth/relay-api.js';
import type { RelayApi } from '../auth/relay-api.js';
import { fakeRelay, mockCredentials, userCancelled } from '../auth/test-credentials.js';
import type { MockedCredentials } from '../auth/test-credentials.js';
import type { OnboardingState } from '../onboarding.js';
import { fixtures } from '../test-fixtures.js';
import { click, renderApp, settle, type } from '../test-render.js';
import type { RenderedApp } from '../test-render.js';

/** Installed iOS app with push granted and a computer paired: only the passkey is missing. */
const signedOut: OnboardingState = { ...fixtures.onboarded, signedIn: false };

const CREATION = {
  challenge: 'Y2hhbGxlbmdl',
  rp: { id: 'localhost', name: 'remote-control' },
  user: { id: 'dXNlci0x', name: 'owner', displayName: 'Owner' },
  pubKeyCredParams: [{ alg: -7, type: 'public-key' as const }],
};
const REQUEST = { challenge: 'bG9naW4', rpId: 'localhost' };

let credentials: MockedCredentials;
let mounted: RenderedApp | undefined;
beforeEach(() => {
  credentials = mockCredentials({ conditional: false });
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  credentials.restore();
  vi.restoreAllMocks();
});

async function mount(path: string, relay: RelayApi) {
  const auth = createAuthStore({ api: relay, initial: { status: 'signed-out' } });
  mounted = await renderApp(path, signedOut, { relay, auth });
  return mounted;
}

const input = (app: RenderedApp, name: string): HTMLInputElement => {
  const found = app.container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (found === null) throw new Error(`no input "${name}"`);
  return found;
};
const alert = (app: RenderedApp) => app.container.querySelector('[role="alert"]')?.textContent;

async function goOffline() {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  await act(async () => {
    window.dispatchEvent(new Event('offline'));
    await Promise.resolve();
  });
}

describe('create passkey', () => {
  it('registers, shows the recovery code once, then continues onboarding', async () => {
    const registerOptions = vi.fn<RelayApi['registerOptions']>(() => Promise.resolve(CREATION));
    const app = await mount(
      '/onboarding/passkey?invite=INV-123',
      fakeRelay({
        registerOptions,
        registerVerify: () =>
          Promise.resolve({ userId: 'user-1', recoveryCode: 'ABCD-EFGH-IJKL', backedUp: true }),
      }),
    );
    expect(app.heading()).toBe('Create your passkey');
    expect(input(app, 'invite').value).toBe('INV-123');
    await type(input(app, 'displayName'), '  Ivan  ');

    await click(app.button('Create passkey'));

    expect(registerOptions).toHaveBeenCalledWith({ inviteCode: 'INV-123', displayName: 'Ivan' });
    expect(credentials.create).toHaveBeenCalledOnce();
    expect(app.heading()).toBe('Save your recovery code');
    expect(app.container.querySelector('pre.recovery-code')?.textContent).toBe('ABCD-EFGH-IJKL');
    expect(app.button('Continue').disabled).toBe(true);

    await click(app.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click(app.button('Continue'));

    // Signed in on an onboarded phone: the gate lets the user through.
    expect(app.path()).toBe('/sessions');
  });

  it('needs an invite code before it opens the sheet', async () => {
    const app = await mount('/onboarding/passkey', fakeRelay());
    expect(app.button('Create passkey').disabled).toBe(true);
    await type(input(app, 'invite'), '   ');
    expect(app.button('Create passkey').disabled).toBe(true);
    await type(input(app, 'invite'), 'INV');
    expect(app.button('Create passkey').disabled).toBe(false);
  });

  it.each<[label: string, error: Error, message: string]>([
    ['invalid invite', new RelayError(403, 'invalid_invite'), 'This invite code is not valid.'],
    [
      'rate limit',
      new RelayError(429, 'rate_limited', 60),
      'Too many attempts — wait a minute and try again.',
    ],
    ['offline', new OfflineError(), 'You are offline — connect to create your passkey.'],
    ['other relay error', new RelayError(500, 'internal'), 'Passkey not created — try again.'],
  ])('explains a %s', async (_label, error, message) => {
    const app = await mount(
      '/onboarding/passkey?invite=INV',
      fakeRelay({ registerOptions: () => Promise.reject(error) }),
    );
    await click(app.button('Create passkey'));
    expect(alert(app)).toBe(message);
    expect(app.heading()).toBe('Create your passkey');
    expect(app.button('Create passkey').disabled).toBe(false);
  });

  it('disables the button while offline', async () => {
    const app = await mount('/onboarding/passkey?invite=INV', fakeRelay());
    await goOffline();
    expect(app.container.textContent).toContain('You are offline');
    expect(app.button('Create passkey').disabled).toBe(true);
  });

  it('links to sign-in', async () => {
    const app = await mount('/onboarding/passkey', fakeRelay());
    await click(app.container.querySelector<HTMLAnchorElement>('a[href="/login"]')!);
    expect(app.path()).toBe('/login');
  });
});

describe('sign in', () => {
  const relay = (overrides: Partial<RelayApi> = {}) =>
    fakeRelay({
      loginOptions: () => Promise.resolve(REQUEST),
      loginVerify: () => Promise.resolve({ userId: 'user-1' }),
      ...overrides,
    });

  it('offers the passkey in the autofill field', async () => {
    const app = await mount('/login', relay());
    const field = app.container.querySelector<HTMLInputElement>('#login-username');
    expect(field?.autocomplete).toBe('username webauthn');
  });

  it('signs in from the button and continues onboarding', async () => {
    const app = await mount('/login', relay());
    await click(app.button('Sign in with passkey'));
    expect(credentials.get).toHaveBeenCalledOnce();
    expect(app.path()).toBe('/sessions');
  });

  it('signs in through autofill when the browser supports it', async () => {
    credentials.restore();
    credentials = mockCredentials({ conditional: true });
    const app = await mount('/login', relay());
    await settle();
    expect(credentials.get.mock.calls[0]?.[0].mediation).toBe('conditional');
    expect(app.path()).toBe('/sessions');
  });

  it('ignores a cancelled autofill ceremony', async () => {
    credentials.restore();
    credentials = mockCredentials({ conditional: true });
    credentials.get.mockRejectedValueOnce(new DOMException('replaced', 'AbortError'));
    const app = await mount('/login', relay());
    await settle();
    expect(app.path()).toBe('/login');
    expect(alert(app)).toBeUndefined();
  });

  it('shows a failed autofill ceremony', async () => {
    credentials.restore();
    credentials = mockCredentials({ conditional: true });
    const app = await mount(
      '/login',
      relay({ loginVerify: () => Promise.reject(new RelayError(401, 'unknown_credential')) }),
    );
    await settle();
    expect(alert(app)).toBe('This passkey is not registered here — create an account.');
  });

  it('stays quiet when the user dismisses the sheet', async () => {
    credentials.get.mockRejectedValueOnce(userCancelled());
    const app = await mount('/login', relay());
    await click(app.button('Sign in with passkey'));
    expect(app.path()).toBe('/login');
    expect(alert(app)).toBeUndefined();
    expect(app.button('Sign in with passkey').disabled).toBe(false);
  });

  it.each<[label: string, error: Error, message: string]>([
    [
      'unknown passkey',
      new RelayError(401, 'unknown_credential'),
      'This passkey is not registered here — create an account.',
    ],
    ['offline relay', new OfflineError(), 'You are offline — connect to sign in.'],
    [
      'rate limit',
      new RelayError(429, 'rate_limited'),
      'Too many attempts — wait a minute and try again.',
    ],
    ['relay failure', new RelayError(400, 'unknown_challenge'), 'Sign-in failed — try again.'],
  ])('explains an %s', async (_label, error, message) => {
    const app = await mount('/login', relay({ loginVerify: () => Promise.reject(error) }));
    await click(app.button('Sign in with passkey'));
    expect(alert(app)).toBe(message);
  });

  it('disables sign-in while offline', async () => {
    const app = await mount('/login', relay());
    await goOffline();
    expect(app.container.textContent).toContain('You are offline — connect to sign in.');
    expect(app.button('Sign in with passkey').disabled).toBe(true);
  });

  it('links to account creation', async () => {
    const app = await mount('/login', relay());
    await click(app.container.querySelector<HTMLAnchorElement>('a[href="/onboarding/passkey"]')!);
    expect(app.heading()).toBe('Create your passkey');
  });
});
