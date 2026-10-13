import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlatformActions } from '../app-state.js';
import type { RequestView } from '../realtime/realtime-store.js';
import { createTestPhone } from '../realtime/test-phone.js';
import type { TestPhone } from '../realtime/test-phone.js';
import { fixtures } from '../test-fixtures.js';
import { renderApp } from '../test-render.js';
import type { RenderedApp } from '../test-render.js';
import { LAUNCH_WINDOW_MS } from './pending-watch.js';
import type { NavigationSource } from './navigation.js';

const ID = '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';

let mounted: RenderedApp | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function pending(test: TestPhone, id = ID): RequestView {
  return {
    machineId: 'agent-1',
    deadline: test.timer.now() + 60_000,
    status: 'pending',
    request: {
      id,
      sessionId: 'sess-1',
      requestHash: 'a'.repeat(64),
      toolLabel: 'Run a command',
      toolName: 'Bash',
      content: 'ls',
      truncated: false,
      suggestions: [],
      expiresAt: 0,
      alwaysSupported: false,
    },
  };
}

function setup(platform: Partial<PlatformActions> = {}) {
  const test = createTestPhone();
  vi.spyOn(test.phone, 'connect').mockResolvedValue();
  const actions: PlatformActions = {
    requestNotificationPermission: () => Promise.resolve('granted'),
    ...platform,
  };
  return { test, platform: actions };
}

const addRequest = (test: TestPhone, id = ID) => {
  act(() => {
    test.phone.realtime.setState({ requests: { [id]: pending(test, id) } });
  });
};

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('pending watch', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('opens a request that arrives right after launch, once', async () => {
    const { test, platform } = setup();
    mounted = await renderApp('/sessions', fixtures.onboarded, { phone: test.phone, platform });
    addRequest(test);
    expect(mounted.path()).toBe(`/requests/${ID}`);
  });

  it('leaves the user alone after the launch window', async () => {
    const { test, platform } = setup();
    mounted = await renderApp('/sessions', fixtures.onboarded, { phone: test.phone, platform });
    act(() => {
      test.timer.advance(LAUNCH_WINDOW_MS + 1);
    });
    addRequest(test);
    expect(mounted.path()).toBe('/sessions');
  });

  it('re-arms when the app comes back to the foreground', async () => {
    const { test, platform } = setup();
    mounted = await renderApp('/sessions', fixtures.onboarded, { phone: test.phone, platform });
    act(() => {
      test.timer.advance(LAUNCH_WINDOW_MS + 1);
    });
    setVisibility('hidden');
    addRequest(test);
    expect(mounted.path()).toBe('/sessions');
    setVisibility('visible');
    act(() => {
      test.phone.realtime.setState({ requests: {} });
    });
    addRequest(test);
    expect(mounted.path()).toBe(`/requests/${ID}`);
  });

  it('does not jump when launched on a request already', async () => {
    const { test, platform } = setup();
    mounted = await renderApp('/requests/doorbell', fixtures.onboarded, {
      phone: test.phone,
      platform,
    });
    addRequest(test);
    // The request screen's own fallback takes it there instead.
    expect(mounted.path()).toBe(`/requests/${ID}`);
  });

  it('keeps the badge at the pending count', async () => {
    const setBadge = vi.fn();
    const { test, platform } = setup({ setBadge });
    mounted = await renderApp('/machines', fixtures.onboarded, { phone: test.phone, platform });
    expect(setBadge).toHaveBeenLastCalledWith(0);
    addRequest(test);
    expect(setBadge).toHaveBeenLastCalledWith(1);
  });

  it('follows navigate messages from the service worker', async () => {
    const serviceWorker = new EventTarget() as EventTarget & NavigationSource;
    const { test, platform } = setup({ serviceWorker });
    mounted = await renderApp('/machines', fixtures.onboarded, { phone: test.phone, platform });
    act(() => {
      serviceWorker.dispatchEvent(
        new MessageEvent('message', { data: { t: 'navigate', url: '/sessions' } }),
      );
    });
    expect(mounted.path()).toBe('/sessions');
  });
});
