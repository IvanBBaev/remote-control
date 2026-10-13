import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OfflineError } from './auth/relay-api.js';
import { fakeRelay } from './auth/test-credentials.js';
import { bootstrap, createPlatformActions, readNotificationPermission } from './bootstrap.js';
import type { BootstrapOptions, NotificationApi } from './bootstrap.js';
import { createTestPhone } from './realtime/test-phone.js';
import './test-render.js';

function notificationApi(permission: NotificationPermission): NotificationApi {
  return { permission, requestPermission: vi.fn(() => Promise.resolve('granted' as const)) };
}

describe('notification permission', () => {
  it('reads the permission, or unsupported without the API', () => {
    expect(readNotificationPermission(undefined)).toBe('unsupported');
    expect(readNotificationPermission(notificationApi('denied'))).toBe('denied');
  });

  it('requests the permission through the API', async () => {
    const api = notificationApi('default');
    await expect(
      createPlatformActions(api, { relay: fakeRelay() }).requestNotificationPermission(),
    ).resolves.toBe('granted');
    expect(api.requestPermission).toHaveBeenCalledOnce();
  });

  it('answers unsupported without the API', async () => {
    await expect(
      createPlatformActions(undefined, { relay: fakeRelay() }).requestNotificationPermission(),
    ).resolves.toBe('unsupported');
  });
});

describe('push and badge actions', () => {
  it('has no push without a service worker', () => {
    const actions = createPlatformActions(undefined, { relay: fakeRelay() });
    expect(actions.registerPush).toBeUndefined();
    expect(actions.serviceWorker).toBeUndefined();
    expect(() => {
      actions.setBadge?.(2);
    }).not.toThrow();
  });

  it('registers push through the ready worker', async () => {
    const subscription = {
      options: { applicationServerKey: null },
      toJSON: () => ({ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: () => Promise.resolve(true),
    };
    const serviceWorker = {
      ready: Promise.resolve({
        pushManager: {
          getSubscription: () => Promise.resolve(null),
          subscribe: () => Promise.resolve(subscription),
        },
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const saved = vi.fn(() => Promise.resolve());
    const relay = fakeRelay({
      pushKey: () => Promise.resolve({ publicKey: 'BPk_-w' }),
      savePushSubscription: saved,
    });
    const actions = createPlatformActions(undefined, { relay, serviceWorker });
    expect(actions.serviceWorker).toBe(serviceWorker);
    await expect(actions.registerPush?.()).resolves.toBe('registered');
    expect(saved).toHaveBeenCalledOnce();
  });

  it('sets the badge to the count and clears it at zero, ignoring refusals', async () => {
    const badge = {
      setAppBadge: vi.fn(() => Promise.reject(new Error('not allowed'))),
      clearAppBadge: vi.fn(() => Promise.resolve()),
    };
    const actions = createPlatformActions(undefined, { relay: fakeRelay(), badge });
    actions.setBadge?.(3);
    actions.setBadge?.(0);
    await Promise.resolve();
    expect(badge.setAppBadge).toHaveBeenCalledWith(3);
    expect(badge.clearAppBadge).toHaveBeenCalledOnce();
  });
});

describe('bootstrap', () => {
  afterEach(() => {
    document.body.replaceChildren();
    window.history.replaceState(null, '', '/');
  });

  async function boot(
    path: string,
    options: Pick<
      BootstrapOptions,
      'relay' | 'hint' | 'serviceWorker' | 'badge' | 'installChoice'
    > &
      Partial<Pick<BootstrapOptions, 'phone' | 'env'>>,
  ) {
    const container = document.createElement('div');
    document.body.append(container);
    window.history.replaceState(null, '', path);
    let root: Awaited<ReturnType<typeof bootstrap>> | undefined;
    await act(async () => {
      root = await bootstrap({
        container,
        env: { navigator: {}, PushManager: class {}, PublicKeyCredential: class {} },
        notifications: notificationApi('granted'),
        checkWebCrypto: () => Promise.resolve(true),
        phone: createTestPhone(options.relay).phone,
        ...options,
      });
    });
    return {
      heading: () => container.querySelector('h1')?.textContent,
      unmount: () => {
        act(() => {
          root?.unmount();
        });
      },
    };
  }

  it('probes the platform and mounts the app at the current step', async () => {
    const app = await boot('/sessions', {
      relay: fakeRelay({ session: () => Promise.resolve(null) }),
    });
    expect(window.location.pathname).toBe('/onboarding/passkey');
    expect(app.heading()).toBe('Create your passkey');
    app.unmount();
  });

  it('skips the passkey step when the session cookie is still valid', async () => {
    const app = await boot('/sessions', {
      relay: fakeRelay({ session: () => Promise.resolve({ userId: 'user-1' }) }),
    });
    expect(window.location.pathname).toBe('/onboarding/install');
    app.unmount();
  });

  it('trusts the session hint when it starts offline', async () => {
    const app = await boot('/sessions', {
      relay: fakeRelay({ session: () => Promise.reject(new OfflineError()) }),
      hint: { read: () => 'user-1', write: () => undefined },
    });
    expect(window.location.pathname).toBe('/onboarding/install');
    app.unmount();
  });

  it('remembers "Continue in the browser" across starts', async () => {
    let skipped = false;
    const installChoice = {
      read: () => skipped,
      skip: () => {
        skipped = true;
      },
    };
    const relay = fakeRelay({ session: () => Promise.resolve({ userId: 'user-1' }) });
    const first = await boot('/sessions', { relay, installChoice });
    expect(window.location.pathname).toBe('/onboarding/install');
    const skip = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Continue in the browser',
    );
    act(() => {
      skip?.click();
    });
    expect(skipped).toBe(true);
    first.unmount();
    const second = await boot('/sessions', { relay, installChoice });
    expect(window.location.pathname).not.toBe('/onboarding/install');
    second.unmount();
  });

  const installed = {
    navigator: { standalone: true },
    PushManager: class {},
    PublicKeyCredential: class {},
  };

  it('starts paired when the key store already holds a computer', async () => {
    const test = createTestPhone(fakeRelay());
    await test.keyStore.saveMachine({
      deviceId: 'agent-1',
      name: 'Studio Mac',
      publicKey: new Uint8Array(32),
      pairedAt: 0,
    });
    const app = await boot('/sessions', {
      relay: fakeRelay({ session: () => Promise.resolve({ userId: 'user-1' }) }),
      phone: test.phone,
      env: installed,
    });
    expect(window.location.pathname).toBe('/sessions');
    app.unmount();
  });

  it('wires the service worker and the badge into the app', async () => {
    const serviceWorker = {
      ready: new Promise<never>(() => undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const badge = { clearAppBadge: vi.fn(() => Promise.resolve()) };
    const test = createTestPhone(fakeRelay());
    vi.spyOn(test.phone, 'pairedCount').mockResolvedValue(1);
    const app = await boot('/sessions', {
      phone: test.phone,
      relay: fakeRelay({ session: () => Promise.resolve({ userId: 'user-1' }) }),
      env: installed,
      serviceWorker,
      badge,
    });
    expect(window.location.pathname).toBe('/sessions');
    expect(serviceWorker.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(badge.clearAppBadge).toHaveBeenCalled();
    app.unmount();
  });

  it('treats an unreadable key store as no computers', async () => {
    const test = createTestPhone(fakeRelay());
    vi.spyOn(test.phone, 'pairedCount').mockRejectedValue(new Error('IndexedDB blocked'));
    const app = await boot('/sessions', {
      relay: fakeRelay({ session: () => Promise.resolve({ userId: 'user-1' }) }),
      phone: test.phone,
      env: installed,
    });
    expect(window.location.pathname).toBe('/onboarding/pair');
    app.unmount();
  });
});
