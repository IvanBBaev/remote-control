import webpush from 'web-push';

import type { PushPort, PushResult } from '../ports/push.js';

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (the PWA's `applicationServerKey`). */
  readonly publicKey: string;
  /** P-256 private scalar, base64url; a secret (D19). */
  readonly privateKey: string;
}

export interface VapidConfig extends VapidKeys {
  /** `mailto:` or `https:` contact for the push service operator (RFC 8292 §2.1). */
  readonly subject: string;
}

export interface WebPushSenderOptions {
  /** Abort a push request after this long; default 10 s. */
  readonly timeoutMs?: number;
}

/** A fresh VAPID key pair (`node dist/admin.js vapid-keys`). */
export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  return { publicKey, privateKey };
}

/**
 * The {@link PushPort} over `web-push`: the library builds the VAPID JWT (RFC 8292) and
 * the aes128gcm body (RFC 8291); the request goes out through `fetch` (no redirects, a
 * timeout). Errors become results — never exceptions, never logged endpoints (D19).
 */
export function createWebPushSender(
  vapid: VapidConfig,
  options: WebPushSenderOptions = {},
): PushPort {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    async send(target, message): Promise<PushResult> {
      let request: webpush.RequestDetails;
      try {
        request = webpush.generateRequestDetails(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          message.payload,
          {
            vapidDetails: vapid,
            TTL: message.ttlSeconds,
            urgency: message.urgency,
            topic: message.topic,
            contentEncoding: 'aes128gcm',
          },
        );
      } catch {
        return { kind: 'failed', status: null };
      }
      try {
        const response = await fetch(request.endpoint, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.body?.cancel();
        if (response.status === 404 || response.status === 410) return { kind: 'gone' };
        if (response.ok) return { kind: 'sent' };
        return { kind: 'failed', status: response.status };
      } catch {
        return { kind: 'failed', status: null };
      }
    },
  };
}
