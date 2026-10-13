import {
  deriveNotificationKey,
  sealPushSummary,
  utf8,
  x25519KeyPairFromPrivateKey,
} from '@remote-control/crypto';
import { encodePushSummary } from '@remote-control/protocol';
import type { PushSummary } from '@remote-control/protocol';
import { IDBFactory } from 'fake-indexeddb';
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
const noKeys = () => Promise.resolve([]);

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
    await handlePush({ showNotification }, pending({ rid: RID, dev: 'Mac' }), noKeys);
    expect(showNotification).toHaveBeenCalledWith('Approval needed on Mac', expect.anything());

    showNotification.mockClear();
    showNotification.mockRejectedValueOnce(new TypeError('bad options'));
    await handlePush({ showNotification }, pending({ rid: RID, dev: 'Mac' }), noKeys);
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
    installServiceWorker({ ...scope, indexedDB: new IDBFactory() } as never, []);
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

describe('push summaries (M1-06)', () => {
  const REQUEST = '7a1b2c3d-4e5f-4a6b-8c7d-0000000000ff';
  const fixed = { bytes: (length: number) => new Uint8Array(length).fill(5) };

  beforeEach(() => {
    vi.stubGlobal('__WB_MANIFEST', manifest);
    vi.stubGlobal('skipWaiting', skipWaiting);
  });

  /** A pairing's two ends: the agent's encrypt key and the phone's decrypt key. */
  async function pairing(agentByte: number) {
    const phone = await x25519KeyPairFromPrivateKey(new Uint8Array(32).fill(9));
    const agent = await x25519KeyPairFromPrivateKey(new Uint8Array(32).fill(agentByte));
    return {
      seal: await deriveNotificationKey(agent.privateKey, phone.publicKey, ['encrypt']),
      open: await deriveNotificationKey(phone.privateKey, agent.publicKey, ['decrypt']),
    };
  }

  async function sealed(key: CryptoKey, envelopeId: string, text: string): Promise<string> {
    const bytes = await sealPushSummary(key, envelopeId, utf8(text), fixed);
    return btoa(String.fromCharCode(...bytes));
  }

  async function pushWith(summary: PushSummary, envelopeId = RID, seal?: CryptoKey) {
    const key = seal ?? (await pairing(21)).seal;
    return pending({
      rid: RID,
      dev: 'Mac',
      sum: await sealed(key, envelopeId, encodePushSummary(summary)),
    });
  }

  it('titles the notification from the summary and opens its request', async () => {
    const { handlePush } = await import('./sw.js');
    const { seal, open } = await pairing(21);
    const other = await pairing(22);
    const showNotification = vi.fn(() => Promise.resolve());
    const text = await pushWith(
      { v: 1, p: 'shop', l: 'Run a command', s: 'API_KEY=*** pnpm deploy', r: REQUEST },
      RID,
      seal,
    );
    await handlePush({ showNotification }, text, () => Promise.resolve([other.open, open]));
    expect(showNotification).toHaveBeenCalledWith('shop: Run a command', {
      body: 'API_KEY=*** pnpm deploy',
      tag: REQUEST,
      data: { url: `/requests/${REQUEST}` },
    });
  });

  it.each<[string, PushSummary, string, Record<string, unknown>]>([
    [
      'the label alone without a project or line',
      { v: 1, l: 'Edit a file' },
      'Edit a file',
      { body: 'Tap to review.', tag: RID, data: { url: `/requests/${RID}` } },
    ],
    [
      'the project and label',
      { v: 1, p: 'api', l: 'Search the web', r: REQUEST },
      'api: Search the web',
      { body: 'Tap to review.', tag: REQUEST, data: { url: `/requests/${REQUEST}` } },
    ],
  ])('shows %s', async (_label, summary, title, options) => {
    const { handlePush } = await import('./sw.js');
    const { seal, open } = await pairing(21);
    const showNotification = vi.fn(() => Promise.resolve());
    await handlePush({ showNotification }, await pushWith(summary, RID, seal), () =>
      Promise.resolve([open]),
    );
    expect(showNotification).toHaveBeenCalledWith(title, options);
  });

  it('opens the app root when neither the summary nor the push names a request', async () => {
    const { summaryNotification } = await import('./sw.js');
    expect(summaryNotification(null, { v: 1, l: 'Run a command' })).toEqual({
      title: 'Run a command',
      options: { body: 'Tap to review.', data: { url: '/' } },
    });
  });

  const GENERIC_ON_MAC = {
    body: 'Tap to review.',
    tag: RID,
    data: { url: `/requests/${RID}` },
  };

  it.each<[string, (keys: { seal: CryptoKey; open: CryptoKey }) => Promise<[string, CryptoKey[]]>]>(
    [
      ['no stored keys', async ({ seal }) => [await pushWith({ v: 1, l: 'x' }, RID, seal), []]],
      [
        'only another pairing’s key',
        async ({ seal }) => [
          await pushWith({ v: 1, l: 'x' }, RID, seal),
          [(await pairing(23)).open],
        ],
      ],
      [
        'a summary sealed for another push',
        async ({ seal, open }) => [
          await pushWith({ v: 1, l: 'x' }, '7a1b2c3d-4e5f-4a6b-8c7d-000000000002', seal),
          [open],
        ],
      ],
      [
        'a summary that is not valid JSON',
        async ({ seal, open }) => [
          pending({ rid: RID, dev: 'Mac', sum: await sealed(seal, RID, '{oops') }),
          [open],
        ],
      ],
      [
        'a summary that is not base64',
        ({ open }) => Promise.resolve([pending({ rid: RID, dev: 'Mac', sum: '***' }), [open]]),
      ],
    ],
  )('falls back to the metadata notification on %s', async (_label, build) => {
    const { handlePush } = await import('./sw.js');
    const [text, keys] = await build(await pairing(21));
    const showNotification = vi.fn(() => Promise.resolve());
    await handlePush({ showNotification }, text, () => Promise.resolve(keys));
    expect(showNotification).toHaveBeenCalledWith('Approval needed on Mac', GENERIC_ON_MAC);
  });

  it('ignores a summary on a push without a request id', async () => {
    const { handlePush } = await import('./sw.js');
    const { seal, open } = await pairing(21);
    const sum = await sealed(seal, RID, encodePushSummary({ v: 1, l: 'x' }));
    const showNotification = vi.fn(() => Promise.resolve());
    await handlePush({ showNotification }, pending({ dev: 'Mac', sum }), () =>
      Promise.resolve([open]),
    );
    expect(showNotification).toHaveBeenCalledWith('Approval needed on Mac', {
      body: 'Tap to review.',
      data: { url: '/' },
    });
  });

  it('falls back to the metadata notification when the keys cannot be read', async () => {
    const { handlePush } = await import('./sw.js');
    const showNotification = vi.fn(() => Promise.resolve());
    await handlePush({ showNotification }, await pushWith({ v: 1, l: 'x' }), () =>
      Promise.reject(new Error('blocked')),
    );
    expect(showNotification).toHaveBeenCalledWith('Approval needed on Mac', GENERIC_ON_MAC);
  });

  it('reads the keys from the worker’s IndexedDB on push', async () => {
    const { installServiceWorker } = await import('./sw.js');
    const listeners = new Map<string, (event: unknown) => void>();
    const showNotification = vi.fn(() => Promise.resolve());
    installServiceWorker(
      {
        skipWaiting: () => Promise.resolve(),
        registration: { showNotification },
        indexedDB: new IDBFactory(),
        addEventListener: (type: string, listener: (event: unknown) => void) => {
          listeners.set(type, listener);
        },
      } as never,
      [],
    );
    const text = await pushWith({ v: 1, l: 'x' });
    const waits: Promise<unknown>[] = [];
    listeners.get('push')?.({
      data: { text: () => text },
      waitUntil: (promise: Promise<unknown>) => void waits.push(promise),
    });
    await Promise.all(waits);
    expect(showNotification).toHaveBeenCalledWith('Approval needed on Mac', GENERIC_ON_MAC);
  });
});
