import type { ApnsEnvironment, PushTarget } from './push.js';

/** Web Push subscription of the PWA. */
export interface WebPushSubscription extends PushTarget {
  readonly kind: 'webpush';
}

/**
 * APNs device token of the native app (`apns`) or of its Live Activity (`apns_activity`,
 * ADR 0017). The token is stored as `endpoint` so one uniqueness rule covers both kinds.
 */
export interface ApnsSubscription {
  readonly kind: 'apns' | 'apns_activity';
  readonly endpoint: string;
  readonly environment: ApnsEnvironment;
}

export type PushSubscription = WebPushSubscription | ApnsSubscription;

export type PushSubscriptionKind = PushSubscription['kind'];

interface StoredFields {
  readonly id: string;
  readonly deviceId: string;
  readonly createdAt: number;
  readonly lastFailureAt: number | null;
}

/** A stored subscription; times are Unix epoch milliseconds. */
export type PushSubscriptionRecord = PushSubscription & StoredFields;

export type SaveSubscription = PushSubscription & {
  readonly userId: string;
  readonly deviceId: string;
};

/**
 * `saved` — stored or refreshed; `taken` — the endpoint belongs to another user's device
 * and was left alone.
 */
export type SaveSubscriptionResult = 'saved' | 'taken';

/** The relay's view of `push_subscriptions` (metadata only, D4). */
export interface PushSubscriptionStore {
  /**
   * Stores a subscription for a phone, or moves an endpoint already stored for another
   * device of the same user (a re-paired phone keeps its subscription). Keeps at most
   * `maxPerDevice` rows of the same kind per device, dropping the oldest. `now` stamps
   * `created_at`.
   */
  save(
    subscription: SaveSubscription,
    maxPerDevice: number,
    now: number,
  ): Promise<SaveSubscriptionResult>;
  listForDevice(deviceId: string): Promise<PushSubscriptionRecord[]>;
  /** Deletes the device's subscription with this endpoint; `false` if there was none. */
  removeEndpoint(deviceId: string, endpoint: string): Promise<boolean>;
  /** Deletes a subscription the push service reported gone. */
  remove(id: string): Promise<void>;
  markFailure(id: string, now: number): Promise<void>;
}
