import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  cleanupOutdatedCaches: vi.fn(),
  precacheAndRoute: vi.fn(),
  createHandlerBoundToURL: vi.fn((url: string) => `handler:${url}`),
  registerRoute: vi.fn(),
  clientsClaim: vi.fn(),
  navigationRoute: vi.fn(),
}));

vi.mock('workbox-core', () => ({ clientsClaim: calls.clientsClaim }));
vi.mock('workbox-precaching', () => ({
  cleanupOutdatedCaches: calls.cleanupOutdatedCaches,
  precacheAndRoute: calls.precacheAndRoute,
  createHandlerBoundToURL: calls.createHandlerBoundToURL,
}));
vi.mock('workbox-routing', () => ({
  registerRoute: calls.registerRoute,
  NavigationRoute: class {
    constructor(...args: unknown[]) {
      calls.navigationRoute(...args);
    }
  },
}));

const manifest = [{ url: 'index.html', revision: 'abc' }];
const skipWaiting = vi.fn(() => Promise.resolve());

describe('service worker', () => {
  beforeEach(() => {
    vi.stubGlobal('__WB_MANIFEST', manifest);
    vi.stubGlobal('skipWaiting', skipWaiting);
  });

  it('precaches the build, serves the shell for navigations and activates at once', async () => {
    const { NAVIGATION_DENYLIST } = await import('./sw.js');
    expect(calls.cleanupOutdatedCaches).toHaveBeenCalledOnce();
    expect(calls.precacheAndRoute).toHaveBeenCalledWith(manifest);
    expect(calls.createHandlerBoundToURL).toHaveBeenCalledWith('index.html');
    expect(calls.navigationRoute).toHaveBeenCalledWith('handler:index.html', {
      denylist: NAVIGATION_DENYLIST,
    });
    expect(calls.registerRoute).toHaveBeenCalledOnce();
    expect(skipWaiting).toHaveBeenCalledOnce();
    expect(calls.clientsClaim).toHaveBeenCalledOnce();
  });

  it.each<[string, boolean]>([
    ['/api/sessions', true],
    ['/api', true],
    ['/ws', true],
    ['/health', true],
    ['/sessions', false],
    ['/apiary', false],
    ['/onboarding/pair', false],
  ])('navigation denylist: %s → %s', async (path, denied) => {
    const { NAVIGATION_DENYLIST } = await import('./sw.js');
    expect(NAVIGATION_DENYLIST.some((pattern) => pattern.test(path))).toBe(denied);
  });
});

const RID = '7a1b2c3d-4e5f-4a6b-8c7d-000000000001';
const pending = (fields: Record<string, unknown>) => JSON.stringify({ t: 'pending', ...fields });

describe('push notifications', () => {
  beforeEach(() => {
    vi.stubGlobal('__WB_MANIFEST', manifest);
    vi.stubGlobal('skipWaiting', skipWaiting);
  });

  it('names the machine and opens the request', async () => {
    const { notificationFor } = await import('./sw.js');
    expect(notificationFor(pending({ rid: RID, dev: ' Studio Mac ', exp: 1 }))).toEqual({
      title: 'Approval needed on Studio Mac',
      options: { body: 'Tap to review.', tag: RID, data: { url: `/requests/${RID}` } },
    });
  });

  it.each<[string, string | null]>([
    ['no body', null],
    ['not JSON', '{oops'],
    ['not an object', '"pending"'],
    ['null', 'null'],
    ['another type', JSON.stringify({ t: 'other', rid: RID, dev: 'Mac' })],
    ['a bad id and a blank name', pending({ rid: '../../x', dev: '  ' })],
    ['wrong field types', pending({ rid: 7, dev: 7 })],
  ])('falls back to the generic notification on %s', async (_label, text) => {
    const { notificationFor } = await import('./sw.js');
    expect(notificationFor(text)).toEqual({
      title: 'Approval needed',
      options: { body: 'Tap to review.', data: { url: '/' } },
    });
  });

  it('always shows a notification, the generic one when the full one fails', async () => {
    const { handlePush } = await import('./sw.js');
    const showNotification = vi.fn(() => Promise.resolve());
    await handlePush({ showNotification }, pending({ rid: RID, dev: 'Mac' }));
    expect(showNotification).toHaveBeenCalledWith('Approval needed on Mac', expect.anything());

    showNotification.mockClear();
    showNotification.mockRejectedValueOnce(new TypeError('bad options'));
    await handlePush({ showNotification }, pending({ rid: RID, dev: 'Mac' }));
    expect(showNotification).toHaveBeenCalledTimes(2);
    expect(showNotification).toHaveBeenLastCalledWith('Approval needed', { data: { url: '/' } });
  });

  function clientsWith(windows: { postMessage: () => void; focus: () => Promise<unknown> }[]) {
    return {
      matchAll: vi.fn(() => Promise.resolve(windows)),
      openWindow: vi.fn(() => Promise.resolve(null)),
    };
  }

  it('focuses an open window and tells it where to go', async () => {
    const { handleClick } = await import('./sw.js');
    const open = { postMessage: vi.fn(), focus: vi.fn(() => Promise.resolve(open)) };
    const clients = clientsWith([open]);
    const close = vi.fn();
    await handleClick({ close, data: { url: `/requests/${RID}` } }, clients as never);
    expect(close).toHaveBeenCalledOnce();
    expect(clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
    expect(open.postMessage).toHaveBeenCalledWith({ t: 'navigate', url: `/requests/${RID}` });
    expect(clients.openWindow).not.toHaveBeenCalled();
  });

  it('opens a window when none is open or focus is refused', async () => {
    const { handleClick } = await import('./sw.js');
    let clients = clientsWith([]);
    await handleClick({ close: vi.fn(), data: { url: `/requests/${RID}` } }, clients as never);
    expect(clients.openWindow).toHaveBeenCalledWith(`/requests/${RID}`);

    const refusing = { postMessage: vi.fn(), focus: vi.fn(() => Promise.reject(new Error('no'))) };
    clients = clientsWith([refusing]);
    await handleClick({ close: vi.fn(), data: { url: '/sessions' } }, clients as never);
    expect(clients.openWindow).toHaveBeenCalledWith('/sessions');
  });

  it.each<[string, unknown]>([
    ['no data', null],
    ['a primitive', 'x'],
    ['no url', {}],
    ['another origin', { url: '//evil.example/x' }],
    ['an absolute URL', { url: 'https://evil.example/x' }],
  ])('opens the app root for %s', async (_label, data) => {
    const { handleClick } = await import('./sw.js');
    const clients = clientsWith([]);
    await handleClick({ close: vi.fn(), data }, clients as never);
    expect(clients.openWindow).toHaveBeenCalledWith('/');
  });

  it('wires push and notificationclick to the handlers', async () => {
    const { installServiceWorker } = await import('./sw.js');
    const listeners = new Map<string, (event: unknown) => void>();
    const showNotification = vi.fn(() => Promise.resolve());
    const clients = clientsWith([]);
    const scope = {
      skipWaiting: () => Promise.resolve(),
      registration: { showNotification },
      clients,
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      },
    };
    installServiceWorker(scope as never, []);
    const waits: Promise<unknown>[] = [];
    const waitUntil = (promise: Promise<unknown>) => void waits.push(promise);

    listeners.get('push')?.({ data: { text: () => pending({ rid: RID, dev: 'Mac' }) }, waitUntil });
    listeners.get('push')?.({ data: null, waitUntil });
    listeners.get('notificationclick')?.({
      notification: { close: vi.fn(), data: { url: '/sessions' } },
      waitUntil,
    });
    await Promise.all(waits);
    expect(showNotification).toHaveBeenNthCalledWith(1, 'Approval needed on Mac', {
      body: 'Tap to review.',
      tag: RID,
      data: { url: `/requests/${RID}` },
    });
    expect(showNotification).toHaveBeenNthCalledWith(2, 'Approval needed', {
      body: 'Tap to review.',
      data: { url: '/' },
    });
    expect(clients.openWindow).toHaveBeenCalledWith('/sessions');
  });
});
