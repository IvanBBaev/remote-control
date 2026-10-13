/// <reference lib="webworker" />
import { openPushSummary } from '@remote-control/crypto';
import { decodePushSummary } from '@remote-control/protocol';
import type { PushSummary } from '@remote-control/protocol';
import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import type { PrecacheEntry } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

import { readPushKeys } from './pairing/key-db.js';

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

/** Where the service worker finds the pairings' decrypt-only notification keys. */
export type PushKeys = () => Promise<readonly CryptoKey[]>;

interface Pending {
  readonly rid?: string;
  readonly dev?: string;
  readonly sum?: string;
}

function parsePending(text: string | null): Pending {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const { t, rid, dev, sum } = parsed as Record<string, unknown>;
    if (t !== 'pending') return {};
    return {
      ...(typeof rid === 'string' && REQUEST_ID.test(rid) && { rid }),
      ...(typeof dev === 'string' && dev.trim() !== '' && { dev: dev.trim() }),
      ...(typeof sum === 'string' && { sum }),
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

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/**
 * Opens the push's sealed summary (D5, M1-06) with whichever pairing's key fits. The
 * summary is bound to the push's envelope id (`rid`), so it cannot be replayed onto
 * another push. Anything that does not open and validate yields `undefined`.
 */
export async function openSummary(
  text: string | null,
  pushKeys: PushKeys,
): Promise<PushSummary | undefined> {
  const { rid, sum } = parsePending(text);
  if (rid === undefined || sum === undefined) return undefined;
  const sealed = fromBase64(sum);
  for (const key of await pushKeys()) {
    try {
      return decodePushSummary(new TextDecoder().decode(await openPushSummary(key, rid, sealed)));
    } catch {
      // Another pairing's key: try the next one.
    }
  }
  return undefined;
}

/**
 * The notification for a push whose summary opened: `"<project>: <tool>"` over the
 * summary line, opening the request the summary names. The tag is the request, so the
 * doorbell's push and the live request's push for it replace one another.
 */
export function summaryNotification(text: string | null, summary: PushSummary): PushNotification {
  const { rid } = parsePending(text);
  const request = summary.r ?? rid;
  return {
    title: summary.p === undefined ? summary.l : `${summary.p}: ${summary.l}`,
    options: {
      body: summary.s ?? 'Tap to review.',
      ...(request !== undefined && { tag: request }),
      data: { url: request === undefined ? '/' : `/requests/${request}` },
    },
  };
}

async function notificationForPush(
  text: string | null,
  pushKeys: PushKeys,
): Promise<PushNotification> {
  try {
    const summary = await openSummary(text, pushKeys);
    if (summary !== undefined) return summaryNotification(text, summary);
  } catch {
    // No keys readable, a malformed blob: the metadata-only notification still shows.
  }
  return notificationFor(text);
}

/**
 * `push` handler. iOS revokes the subscription of a worker that receives a push and shows
 * nothing (05 Rec-1), so this **always** shows a notification: when the full one fails,
 * the generic one, and only then gives up.
 */
export async function handlePush(
  registration: Pick<ServiceWorkerRegistration, 'showNotification'>,
  text: string | null,
  pushKeys: PushKeys,
): Promise<void> {
  const { title, options } = await notificationForPush(text, pushKeys);
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
 * notifications that open the approval card — titled from the sealed summary when one
 * of the pairings' keys opens it, generic otherwise.
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
    event.waitUntil(
      handlePush(scope.registration, event.data?.text() ?? null, () =>
        readPushKeys(scope.indexedDB),
      ),
    );
  });
  scope.addEventListener('notificationclick', (event) => {
    event.waitUntil(handleClick(event.notification, scope.clients));
  });
}

// `self.__WB_MANIFEST` must stay literal: the build replaces exactly this expression.
installServiceWorker(self, self.__WB_MANIFEST);
