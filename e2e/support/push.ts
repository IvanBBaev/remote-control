import type { BrowserContext, Worker } from '@playwright/test';

import { control, type PushTarget } from './control.js';

declare global {
  interface Window {
    __e2eSubscribePush?: () => Promise<PushTarget>;
  }
}

/**
 * Headless Chromium has no push service, so `PushManager.subscribe` is replaced by a
 * subscription at the harness's fake Web Push service: the relay then encrypts and sends
 * real pushes (VAPID, aes128gcm), which the fake service decrypts for `receivedPushes`.
 */
export async function stubPushManager(context: BrowserContext): Promise<void> {
  await context.exposeBinding('__e2eSubscribePush', () => control.subscribePush());
  await context.addInitScript(() => {
    if (typeof PushManager === 'undefined') return;
    const bytes = (base64Url: string): ArrayBuffer =>
      Uint8Array.from(atob(base64Url.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
        char.charCodeAt(0),
      ).buffer;
    let current: PushSubscription | null = null;
    PushManager.prototype.getSubscription = () => Promise.resolve(current);
    PushManager.prototype.subscribe = async (options?: PushSubscriptionOptionsInit) => {
      const target = await window.__e2eSubscribePush!();
      const key = options?.applicationServerKey;
      const json = {
        endpoint: target.endpoint,
        expirationTime: null,
        keys: { p256dh: target.p256dh, auth: target.auth },
      };
      current = {
        endpoint: target.endpoint,
        expirationTime: null,
        options: {
          applicationServerKey: typeof key === 'string' ? bytes(key) : null,
          userVisibleOnly: true,
        },
        toJSON: () => json,
        unsubscribe: () => {
          current = null;
          return Promise.resolve(true);
        },
      } as unknown as PushSubscription;
      return current;
    };
  });
}

/**
 * The Home Screen app on iOS (05 F1) where the engine has neither `PushManager` nor
 * `Notification` (Playwright's WebKit): standalone, with an empty `PushManager` for
 * {@link stubPushManager} to fill and a `Notification` whose prompt the user allows.
 * Add it before {@link stubPushManager}.
 */
export async function emulateHomeScreenApp(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true });
    if (typeof PushManager === 'undefined') {
      class EmulatedPushManager {}
      const manager = new EmulatedPushManager();
      Reflect.set(window, 'PushManager', EmulatedPushManager);
      Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', {
        configurable: true,
        get: () => manager,
      });
    }
    if (!('Notification' in window)) {
      // Kept across reloads, as the real permission is.
      const key = 'e2e.notification.permission';
      Reflect.set(window, 'Notification', {
        get permission() {
          return (sessionStorage.getItem(key) ?? 'default') as NotificationPermission;
        },
        requestPermission: () => {
          sessionStorage.setItem(key, 'granted');
          return Promise.resolve('granted' as const);
        },
      });
    }
  });
}

/** The active service worker, once it controls the app. */
async function activeWorker(context: BrowserContext): Promise<Worker> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await worker.evaluate(async () => {
    const scope = self as unknown as ServiceWorkerGlobalScope;
    while (scope.serviceWorker.state !== 'activated') {
      await new Promise((resolve) => scope.serviceWorker.addEventListener('statechange', resolve));
    }
  });
  return worker;
}

/**
 * Delivers `payload` to the service worker as a `push` event (07 §5.10): the plaintext
 * the relay sent, so the worker's own handler shows the notification.
 */
export async function dispatchPush(context: BrowserContext, payload: string): Promise<void> {
  const worker = await activeWorker(context);
  await worker.evaluate(async (data) => {
    const scope = self as unknown as ServiceWorkerGlobalScope;
    const before = (await scope.registration.getNotifications()).length;
    scope.dispatchEvent(new PushEvent('push', { data }));
    while ((await scope.registration.getNotifications()).length <= before) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, payload);
}

/** Taps the newest notification: a `notificationclick` on the worker's own notification. */
export async function tapNotification(context: BrowserContext): Promise<void> {
  const worker = await activeWorker(context);
  await worker.evaluate(async () => {
    const scope = self as unknown as ServiceWorkerGlobalScope;
    const notification = (await scope.registration.getNotifications()).at(-1);
    if (notification === undefined) throw new Error('no notification to tap');
    scope.dispatchEvent(new NotificationEvent('notificationclick', { notification }));
  });
}
