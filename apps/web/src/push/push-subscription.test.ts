import { describe, expect, it, vi } from 'vitest';

import { RelayError } from '../auth/relay-api.js';
import { fakeRelay } from '../auth/test-credentials.js';
import { registerPush } from './push-subscription.js';
import type { PushManagerLike, PushSubscriptionLike } from './push-subscription.js';

/** `BPk_-w` decodes to these bytes: base64url with both URL-safe characters. */
const KEY = 'BPk_-w';
const KEY_BYTES = new Uint8Array([0x04, 0xf9, 0x3f, 0xfb]).buffer;

function fakeSubscription(
  endpoint: string,
  key: ArrayBuffer | null = KEY_BYTES,
  json: PushSubscriptionJSON = { endpoint, keys: { p256dh: 'p', auth: 'a' } },
): PushSubscriptionLike & { unsubscribe: ReturnType<typeof vi.fn> } {
  return {
    options: { applicationServerKey: key },
    toJSON: () => json,
    unsubscribe: vi.fn(() => Promise.resolve(true)),
  };
}

function fakeManager(existing: PushSubscriptionLike | null, ...fresh: PushSubscriptionLike[]) {
  let current = existing;
  const manager = {
    getSubscription: vi.fn(() => Promise.resolve(current)),
    subscribe: vi.fn(() => {
      const next = fresh.shift();
      if (next === undefined) return Promise.reject(new Error('no more subscriptions'));
      current = next;
      return Promise.resolve(next);
    }),
  } satisfies PushManagerLike;
  return manager;
}

function relayWith(save: (input: unknown) => Promise<void> = () => Promise.resolve()) {
  const saved = vi.fn(save);
  const relay = fakeRelay({
    pushKey: () => Promise.resolve({ publicKey: KEY }),
    savePushSubscription: saved,
  });
  return Object.assign(relay, { saved });
}

describe('push registration', () => {
  it('subscribes with the VAPID key and stores the subscription', async () => {
    const manager = fakeManager(null, fakeSubscription('https://push.example/1'));
    const relay = relayWith();
    await expect(registerPush(manager, relay)).resolves.toBe('registered');
    expect(manager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: KEY,
    });
    expect(relay.saved).toHaveBeenCalledWith({
      endpoint: 'https://push.example/1',
      expirationTime: null,
      keys: { p256dh: 'p', auth: 'a' },
    });
  });

  it('keeps a subscription made for the same key', async () => {
    const existing = fakeSubscription('https://push.example/1', KEY_BYTES, {
      endpoint: 'https://push.example/1',
      expirationTime: 99,
      keys: { p256dh: 'p', auth: 'a' },
    });
    const manager = fakeManager(existing);
    const relay = relayWith();
    await expect(registerPush(manager, relay)).resolves.toBe('registered');
    expect(manager.subscribe).not.toHaveBeenCalled();
    expect(relay.saved).toHaveBeenCalledWith(expect.objectContaining({ expirationTime: 99 }));
  });

  it.each<[string, ArrayBuffer | null]>([
    ['another key', new Uint8Array([1, 2, 3]).buffer],
    ['no key', null],
  ])('replaces a subscription made with %s', async (_label, key) => {
    const old = fakeSubscription('https://push.example/old', key);
    const manager = fakeManager(old, fakeSubscription('https://push.example/new'));
    const relay = relayWith();
    await expect(registerPush(manager, relay)).resolves.toBe('registered');
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(relay.saved).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://push.example/new' }),
    );
  });

  it('re-subscribes once when another phone holds the endpoint', async () => {
    const taken = fakeSubscription('https://push.example/taken');
    const manager = fakeManager(taken, fakeSubscription('https://push.example/new'));
    const relay = relayWith((input) =>
      (input as { endpoint: string }).endpoint.endsWith('taken')
        ? Promise.reject(new RelayError(409, 'endpoint_taken'))
        : Promise.resolve(),
    );
    await expect(registerPush(manager, relay)).resolves.toBe('registered');
    expect(taken.unsubscribe).toHaveBeenCalledOnce();
    expect(relay.saved).toHaveBeenCalledTimes(2);
  });

  it('gives up when the endpoint is still taken after a fresh subscription', async () => {
    const manager = fakeManager(
      fakeSubscription('https://push.example/1'),
      fakeSubscription('https://push.example/2'),
    );
    const relay = relayWith(() => Promise.reject(new RelayError(409, 'endpoint_taken')));
    await expect(registerPush(manager, relay)).resolves.toBe('failed');
    expect(relay.saved).toHaveBeenCalledTimes(2);
  });

  it.each<[string, () => ReturnType<typeof fakeManager>, () => ReturnType<typeof relayWith>]>([
    [
      'the relay refuses',
      () => fakeManager(null, fakeSubscription('https://push.example/1')),
      () => relayWith(() => Promise.reject(new RelayError(403, 'no_phone'))),
    ],
    [
      'the subscription has no keys',
      () => fakeManager(null, fakeSubscription('https://push.example/1', KEY_BYTES, {})),
      () => relayWith(),
    ],
    [
      'the subscription lacks the auth key',
      () =>
        fakeManager(
          null,
          fakeSubscription('https://push.example/1', KEY_BYTES, {
            endpoint: 'https://push.example/1',
            keys: { p256dh: 'p' },
          }),
        ),
      () => relayWith(),
    ],
    ['subscribing is denied', () => fakeManager(null), () => relayWith()],
  ])('fails quietly when %s', async (_label, manager, relay) => {
    await expect(registerPush(manager(), relay())).resolves.toBe('failed');
  });

  it('fails quietly when the key cannot be fetched', async () => {
    const manager = fakeManager(null);
    await expect(registerPush(manager, fakeRelay())).resolves.toBe('failed');
    expect(manager.getSubscription).not.toHaveBeenCalled();
  });
});
