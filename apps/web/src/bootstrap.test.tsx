import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bootstrap, createPlatformActions, readNotificationPermission } from './bootstrap.js';
import type { NotificationApi } from './bootstrap.js';
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
    await expect(createPlatformActions(api).requestNotificationPermission()).resolves.toBe(
      'granted',
    );
    expect(api.requestPermission).toHaveBeenCalledOnce();
  });

  it('answers unsupported without the API', async () => {
    await expect(createPlatformActions(undefined).requestNotificationPermission()).resolves.toBe(
      'unsupported',
    );
  });
});

describe('bootstrap', () => {
  afterEach(() => {
    document.body.replaceChildren();
    window.history.replaceState(null, '', '/');
  });

  it('probes the platform and mounts the app at the current step', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    window.history.replaceState(null, '', '/sessions');
    let root: Awaited<ReturnType<typeof bootstrap>> | undefined;
    await act(async () => {
      root = await bootstrap({
        container,
        env: { navigator: {}, PushManager: class {}, PublicKeyCredential: class {} },
        notifications: notificationApi('default'),
        checkWebCrypto: () => Promise.resolve(true),
      });
    });
    expect(window.location.pathname).toBe('/onboarding/passkey');
    expect(container.querySelector('h1')?.textContent).toBe('Create your passkey');
    act(() => {
      root?.unmount();
    });
  });
});
