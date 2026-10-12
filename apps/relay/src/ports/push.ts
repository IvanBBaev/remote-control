/** A browser push subscription as the PWA registers it (RFC 8030 / RFC 8291). */
export interface PushTarget {
  /** The push service URL; a capability, so it never appears in logs (D19). */
  readonly endpoint: string;
  /** The subscriber's P-256 public key, base64url (65 bytes uncompressed). */
  readonly p256dh: string;
  /** The subscriber's auth secret, base64url (16 bytes). */
  readonly auth: string;
}

/** One push message; `payload` is metadata only (D5) and is encrypted by the adapter. */
export interface PushMessage {
  readonly payload: string;
  /** Replaces an earlier undelivered message with the same topic (RFC 8030 §5.4). */
  readonly topic: string;
  /** Seconds the push service may hold the message; never 0 (callers skip instead). */
  readonly ttlSeconds: number;
  readonly urgency: 'very-low' | 'low' | 'normal' | 'high';
}

export type PushResult =
  | { readonly kind: 'sent' }
  /** 404 or 410: the subscription is gone and must be deleted. */
  | { readonly kind: 'gone' }
  /** Any other outcome; `status` is `null` when no HTTP response arrived. */
  | { readonly kind: 'failed'; readonly status: number | null };

/**
 * Sends one Web Push message (VAPID-signed, aes128gcm-encrypted). Production uses
 * `adapters/web-push-sender.ts`; it never throws, every failure is a `PushResult`.
 */
export interface PushPort {
  send(target: PushTarget, message: PushMessage): Promise<PushResult>;
}
