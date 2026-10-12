import type { PushTarget } from './push.js';

/** A stored subscription; times are Unix epoch milliseconds. */
export interface PushSubscriptionRecord extends PushTarget {
  readonly id: string;
  readonly deviceId: string;
  readonly createdAt: number;
  readonly lastFailureAt: number | null;
}

export interface SaveSubscription extends PushTarget {
  readonly userId: string;
  readonly deviceId: string;
}

/**
 * `saved` — stored or refreshed; `taken` — the endpoint belongs to another user's device
 * and was left alone.
 */
export type SaveSubscriptionResult = 'saved' | 'taken';

/** The relay's view of `push_subscriptions` (metadata only, D4). */
export interface PushSubscriptionStore {
  /**
   * Stores a subscription for a phone, or moves an endpoint already stored for another
   * device of the same user (a re-paired phone keeps its browser subscription). Keeps at
   * most `maxPerDevice` rows per device, dropping the oldest. `now` stamps `created_at`.
   */
  save(
    subscription: SaveSubscription,
    maxPerDevice: number,
    now: number,
  ): Promise<SaveSubscriptionResult>;
  listForDevice(deviceId: string): Promise<PushSubscriptionRecord[]>;
  /** Deletes the device's subscription with this endpoint; `false` if there was none. */
  removeEndpoint(deviceId: string, endpoint: string): Promise<boolean>;
  /** Deletes a subscription the push service reported gone (404/410). */
  remove(id: string): Promise<void>;
  markFailure(id: string, now: number): Promise<void>;
}
