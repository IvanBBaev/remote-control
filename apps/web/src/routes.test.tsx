import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OnboardingState } from './onboarding.js';
import { fixtures } from './test-fixtures.js';
import { click, renderApp } from './test-render.js';
import type { RenderedApp } from './test-render.js';

const { iosTab, androidTab, oldBrowser, iosInstalled } = fixtures.capabilities;
const { onboarded } = fixtures;

let mounted: RenderedApp | undefined;
async function mount(
  path: string,
  state: OnboardingState,
  platform?: Parameters<typeof renderApp>[2],
) {
  mounted = await renderApp(path, state, platform);
  return mounted;
}
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

const fresh: OnboardingState = {
  capabilities: androidTab,
  signedIn: false,
  installSkipped: false,
  notificationPermission: 'default',
  paired: false,
};

describe('route table (onboarded user)', () => {
  it.each<[path: string, heading: string]>([
    ['/sessions', 'Sessions'],
    ['/machines', 'Computers'],
    ['/sessions/s-42', 'Session'],
    ['/requests/r-7', 'Approval request'],
    ['/new', 'New session'],
    ['/login', 'Sign in'],
    ['/onboarding/pair', 'Add your first computer'],
    ['/no-such-page', 'Page not found'],
  ])('%s renders "%s"', async (path, heading) => {
    const app = await mount(path, onboarded);
    expect(app.path()).toBe(path);
    expect(app.heading()).toBe(heading);
  });

  it('redirects / to /sessions', async () => {
    const app = await mount('/', onboarded);
    expect(app.path()).toBe('/sessions');
  });

  it('shows the route parameter on the session and request screens', async () => {
    const session = await mount('/sessions/s-42', onboarded);
    expect(session.container.textContent).toContain('s-42');
    session.unmount();
    const request = await mount('/requests/r-7', onboarded);
    expect(request.container.textContent).toContain('r-7');
  });

  it('shows the tab bar inside the gated app only', async () => {
    const app = await mount('/sessions', onboarded);
    expect(app.container.querySelector('nav.tab-bar')).not.toBeNull();
    app.unmount();
    const login = await mount('/login', onboarded);
    expect(login.container.querySelector('nav.tab-bar')).toBeNull();
  });

  it('sends a finished user away from earlier onboarding steps', async () => {
    const app = await mount('/onboarding/passkey', onboarded);
    expect(app.path()).toBe('/sessions');
  });

  it.each(['/onboarding', '/onboarding/whatever'])('%s goes home when done', async (path) => {
    const app = await mount(path, onboarded);
    expect(app.path()).toBe('/sessions');
  });
});

describe('onboarding gate', () => {
  it.each<[name: string, state: OnboardingState, path: string, heading: string]>([
    [
      'old browser',
      { ...fresh, capabilities: oldBrowser },
      '/onboarding/update-browser',
      'Update your browser',
    ],
    ['not signed in', fresh, '/onboarding/passkey', 'Create your passkey'],
    [
      'iOS tab',
      { ...fresh, capabilities: iosTab, signedIn: true },
      '/onboarding/install',
      'Install the app',
    ],
    [
      'no notification permission',
      { ...fresh, capabilities: iosInstalled, signedIn: true },
      '/onboarding/notifications',
      'Turn on notifications',
    ],
    [
      'nothing paired',
      { ...onboarded, paired: false },
      '/onboarding/pair',
      'Add your first computer',
    ],
  ])('%s: /sessions redirects to %s', async (_name, state, path, heading) => {
    const app = await mount('/sessions', state);
    expect(app.path()).toBe(path);
    expect(app.heading()).toBe(heading);
  });

  it('/onboarding resolves to the current step', async () => {
    const app = await mount('/onboarding', fresh);
    expect(app.path()).toBe('/onboarding/passkey');
  });

  it('a step out of order redirects to the current step', async () => {
    const app = await mount('/onboarding/pair', fresh);
    expect(app.path()).toBe('/onboarding/passkey');
  });

  it('lists the missing capabilities on the update screen', async () => {
    const app = await mount('/onboarding/update-browser', { ...fresh, capabilities: oldBrowser });
    const items = [...app.container.querySelectorAll('ul.missing li')].map((li) => li.textContent);
    expect(items).toEqual(['Passkeys (WebAuthn)', 'End-to-end encryption (WebCrypto X25519)']);
  });

  it('lets an Android tab skip the install step', async () => {
    const app = await mount('/onboarding/install', { ...fresh, signedIn: true });
    await click(app.button('Continue in the browser'));
    expect(app.path()).toBe('/onboarding/notifications');
  });

  it('offers no skip where installing is required (iOS tab)', async () => {
    const app = await mount('/onboarding/install', {
      ...fresh,
      capabilities: iosTab,
      signedIn: true,
    });
    expect(app.container.textContent).toContain('Add to Home Screen');
    expect(() => app.button('Continue in the browser')).toThrow();
  });

  it('asks for notification permission from the tap and moves on when granted', async () => {
    const requestNotificationPermission = vi.fn(() => Promise.resolve('granted' as const));
    const app = await mount(
      '/onboarding/notifications',
      { ...fresh, capabilities: iosInstalled, signedIn: true },
      { requestNotificationPermission },
    );
    await click(app.button('Enable notifications'));
    expect(requestNotificationPermission).toHaveBeenCalledOnce();
    expect(app.path()).toBe('/onboarding/pair');
  });

  it('uses the default platform when none is given', async () => {
    const app = await mount('/onboarding/notifications', {
      ...fresh,
      capabilities: iosInstalled,
      signedIn: true,
    });
    await click(app.button('Enable notifications'));
    expect(app.path()).toBe('/onboarding/pair');
  });

  it('explains a denied permission and disables the button', async () => {
    const app = await mount(
      '/onboarding/notifications',
      { ...fresh, capabilities: iosInstalled, signedIn: true },
      { requestNotificationPermission: () => Promise.resolve('denied') },
    );
    await click(app.button('Enable notifications'));
    expect(app.path()).toBe('/onboarding/notifications');
    expect(app.container.textContent).toContain('Notifications are blocked');
    expect(app.button('Enable notifications').disabled).toBe(true);
  });

  it('explains when notifications are unsupported', async () => {
    const app = await mount('/onboarding/notifications', {
      ...fresh,
      capabilities: iosInstalled,
      signedIn: true,
      notificationPermission: 'unsupported',
    });
    expect(app.container.textContent).toContain('cannot show notifications');
  });

  it('keeps the typed pairing code', async () => {
    const app = await mount('/onboarding/pair', { ...onboarded, paired: false });
    const input = app.container.querySelector<HTMLInputElement>('#pair-code');
    expect(input).not.toBeNull();
    await act(async () => {
      // React tracks the value through the prototype setter, so set it the same way.
      Reflect.set(HTMLInputElement.prototype, 'value', 'ABCD-EFGH', input);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    expect(input?.value).toBe('ABCD-EFGH');
  });

  it('forms do not navigate on submit', async () => {
    for (const path of ['/onboarding/pair', '/sessions/s-1', '/new']) {
      const app = await mount(path, onboarded);
      const form = app.container.querySelector('form');
      const event = new Event('submit', { bubbles: true, cancelable: true });
      act(() => {
        form?.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      app.unmount();
      mounted = undefined;
    }
  });
});
