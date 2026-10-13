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
