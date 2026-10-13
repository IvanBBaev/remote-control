import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAppState } from './app-state.js';
import { fakeRelay } from './auth/test-credentials.js';
import type { OnboardingState } from './onboarding.js';
import { createTestPhone } from './realtime/test-phone.js';
import { fixtures } from './test-fixtures.js';
import { render, renderApp, settle } from './test-render.js';
import type { RenderedApp } from './test-render.js';

let mounted: RenderedApp | undefined;

function Reader() {
  useAppState();
  return null;
}

describe('useAppState', () => {
  it('throws outside the provider', async () => {
    const original = console.error;
    console.error = () => undefined;
    try {
      await expect(render(<Reader />)).rejects.toThrow('outside <AppStateProvider>');
    } finally {
      console.error = original;
    }
  });
});

describe('push registration', () => {
  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  function setup(permission: OnboardingState['notificationPermission']) {
    const test = createTestPhone();
    const connect = vi.spyOn(test.phone, 'connect').mockResolvedValue();
    const registerPush = vi.fn(() => Promise.resolve('registered'));
    const platform = {
      requestNotificationPermission: () => Promise.resolve('granted' as const),
      registerPush,
    };
    return { test, connect, registerPush, platform, permission };
  }

  it('registers push once the phone is connected and notifications are granted', async () => {
    const { test, connect, registerPush, platform } = setup('granted');
    mounted = await renderApp('/sessions', fixtures.onboarded, { phone: test.phone, platform });
    await settle();
    expect(connect).toHaveBeenCalledWith('user-1');
    expect(registerPush).toHaveBeenCalled();
  });

  it('does not register push without permission', async () => {
    const { test, registerPush, platform } = setup('denied');
    mounted = await renderApp(
      '/sessions',
      { ...fixtures.onboarded, notificationPermission: 'denied' },
      { phone: test.phone, platform },
    );
    await settle();
    expect(registerPush).not.toHaveBeenCalled();
  });

  it('does not register push when connecting fails', async () => {
    const { test, connect, registerPush, platform } = setup('granted');
    connect.mockRejectedValue(new Error('offline'));
    mounted = await renderApp('/sessions', fixtures.onboarded, { phone: test.phone, platform });
    await settle();
    expect(registerPush).not.toHaveBeenCalled();
  });
});

describe('revocation (M1-10)', () => {
  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it('signs out once the relay revoked this phone or deleted the account', async () => {
    const test = createTestPhone();
    vi.spyOn(test.phone, 'connect').mockResolvedValue();
    const logout = vi.fn(() => Promise.resolve());
    mounted = await renderApp('/sessions', fixtures.onboarded, {
      phone: test.phone,
      relay: fakeRelay({ logout }),
    });
    await settle();
    expect(logout).not.toHaveBeenCalled();
    act(() => {
      test.phone.realtime.setState({ revoked: 'account_deleted' });
    });
    await settle();
    expect(logout).toHaveBeenCalledOnce();
    expect(mounted.path()).toBe('/onboarding/passkey');
  });
});
