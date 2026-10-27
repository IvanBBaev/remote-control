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

/** The APNs environment a device token belongs to; a development build gets sandbox tokens. */
export type ApnsEnvironment = 'sandbox' | 'production';

/** A native app's APNs device token (ADR 0017). */
export interface ApnsTarget {
  /** Hex device token; a capability, so it never appears in logs (D19). */
  readonly token: string;
  readonly environment: ApnsEnvironment;
}

/** One APNs alert; `payload` is the JSON body and carries metadata only (D5). */
export interface ApnsMessage {
  readonly payload: string;
  /** `apns-collapse-id`: replaces an earlier notification for the same request. */
  readonly collapseId: string;
  /** `apns-expiration`, Unix epoch seconds; never in the past (callers skip instead). */
  readonly expiration: number;
}

/**
 * Sends one APNs alert with token-based provider auth (ES256 JWT from the `.p8` key).
 * Production uses `adapters/apns-sender.ts`; it never throws, every failure is a
 * `PushResult` (`gone` for an unregistered or foreign token).
 */
export interface ApnsPort {
  send(target: ApnsTarget, message: ApnsMessage): Promise<PushResult>;
}
