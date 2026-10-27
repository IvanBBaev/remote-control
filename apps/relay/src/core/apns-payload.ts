import type { PendingPushPayload } from './push-payload.js';

/** APNs rejects an alert body above 4 KB. */
export const MAX_APNS_PAYLOAD_BYTES = 4096;

/** Category of a pending-request notification; the app registers its actions (ADR 0017). */
export const APNS_PENDING_CATEGORY = 'rc.pending';

/**
 * The APNs body of a pending request (M4-05, D5). The visible alert is generic — the
 * relay never sees plaintext (I1) — and `mutable-content` lets the app's Notification
 * Service Extension open `rc.sum` with the notification key (ADR 0001), then replace the
 * title, body and category before the alert shows. `rc` is the same metadata-only object
 * a Web Push carries (`encodePendingPayload`).
 *
 * `pendingPayload` must be that function's output; `thread` groups alerts per agent.
 */
export function encodeApnsAlert(pendingPayload: string, thread: string): string {
  const rc = JSON.parse(pendingPayload) as PendingPushPayload;
  return JSON.stringify({
    aps: {
      alert: {
        title: rc.dev === '' ? 'Approval needed' : `Approval needed on ${rc.dev}`,
        body: 'Tap to review.',
      },
      sound: 'default',
      category: APNS_PENDING_CATEGORY,
      'mutable-content': 1,
      'interruption-level': 'time-sensitive',
      'thread-id': thread,
    },
    rc,
  });
}

/** Unix epoch seconds after which APNs drops an undelivered alert (`apns-expiration`). */
export function apnsExpiration(now: number, ttlSeconds: number): number {
  return Math.floor(now / 1000) + ttlSeconds;
}
