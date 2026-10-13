/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import type { PrecacheEntry } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | PrecacheEntry)[];
};

/** Paths the relay serves itself; they never fall back to the app shell. */
export const NAVIGATION_DENYLIST: RegExp[] = [/^\/api(\/|$)/, /^\/ws(\/|$)/, /^\/health(\/|$)/];

/** What the page's navigation listener accepts from the service worker. */
export interface NavigateMessage {
  readonly t: 'navigate';
  readonly url: string;
}

/** The notification to show for one push; built without touching any global. */
export interface PushNotification {
  readonly title: string;
  readonly options: NotificationOptions & { readonly data: { readonly url: string } };
}

const GENERIC_TITLE = 'Approval needed';
/** Request ids are UUIDs; anything else never reaches a URL. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parsePending(text: string | null): { rid?: string; dev?: string } {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const { t, rid, dev } = parsed as Record<string, unknown>;
    if (t !== 'pending') return {};
    return {
      ...(typeof rid === 'string' && REQUEST_ID.test(rid) && { rid }),
      ...(typeof dev === 'string' && dev.trim() !== '' && { dev: dev.trim() }),
    };
  } catch {
    return {};
  }
}

/**
 * The notification for a push body (D5: `{t:"pending", rid, dev, exp}`, metadata only).
 * A body that does not parse still yields a notification: generic text, opening the app.
 * The request is shown under its id's tag, so a repeated push replaces, never stacks.
 */
export function notificationFor(text: string | null): PushNotification {
  const { rid, dev } = parsePending(text);
  return {
    title: dev === undefined ? GENERIC_TITLE : `${GENERIC_TITLE} on ${dev}`,
    options: {
      body: 'Tap to review.',
      ...(rid !== undefined && { tag: rid }),
      data: { url: rid === undefined ? '/' : `/requests/${rid}` },
    },
  };
}

/**
 * `push` handler. iOS revokes the subscription of a worker that receives a push and shows
 * nothing (05 Rec-1), so this **always** shows a notification: when the full one fails,
 * the generic one, and only then gives up.
 */
export async function handlePush(
  registration: Pick<ServiceWorkerRegistration, 'showNotification'>,
  text: string | null,
): Promise<void> {
  const { title, options } = notificationFor(text);
  try {
    await registration.showNotification(title, options);
  } catch {
    await registration.showNotification(GENERIC_TITLE, { data: { url: '/' } });
  }
}

function urlOf(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '/';
  const { url } = data as Record<string, unknown>;
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/';
}

/**
 * `notificationclick` handler: an open window is focused and told where to go (the
 * page's router navigates, so its state survives); without one, the app opens there.
 */
export async function handleClick(
  notification: Pick<Notification, 'close' | 'data'>,
  clients: Pick<Clients, 'matchAll' | 'openWindow'>,
): Promise<void> {
  notification.close();
  const url = urlOf(notification.data);
  const [open] = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (open !== undefined) {
    open.postMessage({ t: 'navigate', url } satisfies NavigateMessage);
    try {
      await open.focus();
      return;
    } catch {
      // Focus is refused outside the click's activation window: open a window instead.
    }
  }
  await clients.openWindow(url);
}

/**
 * The service worker: precache the build (the list vite-plugin-pwa injects), answer
 * navigations with the app shell, take over open pages at once, and turn pushes into
 * notifications that open the approval card.
 */
export function installServiceWorker(
  scope: ServiceWorkerGlobalScope,
  manifest: (string | PrecacheEntry)[],
): void {
  cleanupOutdatedCaches();
  precacheAndRoute(manifest);
  registerRoute(
    new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: NAVIGATION_DENYLIST }),
  );
  void scope.skipWaiting();
  clientsClaim();
  scope.addEventListener('push', (event) => {
    event.waitUntil(handlePush(scope.registration, event.data?.text() ?? null));
  });
  scope.addEventListener('notificationclick', (event) => {
    event.waitUntil(handleClick(event.notification, scope.clients));
  });
}

// `self.__WB_MANIFEST` must stay literal: the build replaces exactly this expression.
installServiceWorker(self, self.__WB_MANIFEST);
