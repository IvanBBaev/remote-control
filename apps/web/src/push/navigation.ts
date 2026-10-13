/** The slice of `ServiceWorkerContainer` that carries the worker's messages. */
export interface NavigationSource {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

function navigationUrl(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { t, url } = data as { t?: unknown; url?: unknown };
  if (t !== 'navigate' || typeof url !== 'string') return undefined;
  // Same-origin paths only: `//host` would leave the app.
  return url.startsWith('/') && !url.startsWith('//') ? url : undefined;
}

/**
 * Follows the service worker's `{ t: 'navigate', url }` after a notification tap on an
 * open app (M0-21). Returns the unsubscribe function.
 */
export function listenForNavigation(
  source: NavigationSource,
  navigate: (url: string) => void,
): () => void {
  const listener = (event: MessageEvent) => {
    const url = navigationUrl(event.data);
    if (url !== undefined) navigate(url);
  };
  source.addEventListener('message', listener);
  return () => {
    source.removeEventListener('message', listener);
  };
}
