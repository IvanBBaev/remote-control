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

/**
 * Minimal service worker: precache the build (the list vite-plugin-pwa injects), answer
 * navigations with the app shell, and take over open pages at once. Push handling comes
 * with the push work package.
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
}

// `self.__WB_MANIFEST` must stay literal: the build replaces exactly this expression.
installServiceWorker(self, self.__WB_MANIFEST);
