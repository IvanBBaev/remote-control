import { RelayError } from '../auth/relay-api.js';
import type { PushSubscriptionInput, RelayApi } from '../auth/relay-api.js';

/** The slice of `PushSubscription` the app uses. */
export interface PushSubscriptionLike {
  readonly options: { readonly applicationServerKey: ArrayBuffer | null };
  readonly toJSON: () => PushSubscriptionJSON;
  readonly unsubscribe: () => Promise<boolean>;
}

/** The slice of `PushManager` the app uses. */
export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: {
    userVisibleOnly: true;
    applicationServerKey: string;
  }): Promise<PushSubscriptionLike>;
}

export type PushRegistration = 'registered' | 'failed';

function base64Url(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function toInput(subscription: PushSubscriptionLike): PushSubscriptionInput | undefined {
  const { endpoint, expirationTime, keys } = subscription.toJSON();
  if (endpoint === undefined || keys?.p256dh === undefined || keys.auth === undefined) {
    return undefined;
  }
  return {
    endpoint,
    expirationTime: expirationTime ?? null,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}

/** A fresh subscription for `publicKey`, dropping one made for another key first. */
async function subscription(
  manager: PushManagerLike,
  publicKey: string,
  fresh: boolean,
): Promise<PushSubscriptionLike> {
  const existing = await manager.getSubscription();
  if (existing !== null) {
    const key = existing.options.applicationServerKey;
    if (!fresh && key !== null && base64Url(key) === publicKey) return existing;
    await existing.unsubscribe();
  }
  return manager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
}

async function save(
  manager: PushManagerLike,
  relay: Pick<RelayApi, 'savePushSubscription'>,
  publicKey: string,
  fresh: boolean,
): Promise<void> {
  const input = toInput(await subscription(manager, publicKey, fresh));
  if (input === undefined) throw new Error('the push subscription has no keys');
  await relay.savePushSubscription(input);
}

/**
 * Subscribes this phone to Web Push with the relay's VAPID key and stores the
 * subscription on the relay (D5, M0-12). Runs on every launch once notifications are
 * granted and the phone is bound: the relay keeps the latest, so a rotated key or an
 * endpoint iOS replaced is picked up. An endpoint the relay holds for another phone
 * (`endpoint_taken`) is replaced by a new subscription once.
 */
export async function registerPush(
  manager: PushManagerLike,
  relay: Pick<RelayApi, 'pushKey' | 'savePushSubscription'>,
): Promise<PushRegistration> {
  try {
    const { publicKey } = await relay.pushKey();
    try {
      await save(manager, relay, publicKey, false);
    } catch (error) {
      if (!(error instanceof RelayError && error.reason === 'endpoint_taken')) throw error;
      await save(manager, relay, publicKey, true);
    }
    return 'registered';
  } catch {
    return 'failed';
  }
}
