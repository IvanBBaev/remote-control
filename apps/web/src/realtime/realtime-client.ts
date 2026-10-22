// The client moved to @remote-control/phone-core (M4-03); the browser lifecycle binding
// stays here, as the native app wakes the client from its own app-state events.
import type { RealtimeClient } from '@remote-control/phone-core/realtime/realtime-client';

export * from '@remote-control/phone-core/realtime/realtime-client';

export interface LifecycleTarget {
  readonly document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/**
 * Rec-5: a suspended tab's socket may be dead without a close event, so the client wakes
 * on `visibilitychange` (to visible), `pageshow` (bfcache restore) and `online`.
 */
export function bindLifecycle(
  client: Pick<RealtimeClient, 'wake'>,
  target: LifecycleTarget,
): () => void {
  const onVisibility = (): void => {
    if (target.document.visibilityState === 'visible') client.wake();
  };
  const wake = (): void => {
    client.wake();
  };
  target.document.addEventListener('visibilitychange', onVisibility);
  target.window.addEventListener('pageshow', wake);
  target.window.addEventListener('online', wake);
  return () => {
    target.document.removeEventListener('visibilitychange', onVisibility);
    target.window.removeEventListener('pageshow', wake);
    target.window.removeEventListener('online', wake);
  };
}
