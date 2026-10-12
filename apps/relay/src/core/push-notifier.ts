import type { Clock } from '@remote-control/protocol';
import type { Logger } from 'pino';

import type { DeviceDirectory } from '../ports/device-directory.js';
import type { PushPort } from '../ports/push.js';
import type { PushSubscriptionStore } from '../ports/push-subscription-store.js';
import type { AuditSink, PendingRequestSink, UndeliveredEnvelope } from '../ports/relay-seams.js';
import type { TrackedDelivery } from './ack-tracker.js';
import { encodePendingPayload, pushTopic, pushTtlSeconds } from './push-payload.js';
import { FixedWindowRateLimiter, type RateLimit } from './rate-limiter.js';

export interface PushLimits {
  /** Pushes per phone device (the per-device rate cap). */
  readonly perDevice: RateLimit;
  /** Pushes per request id: a request re-sent in the same session buzzes once. */
  readonly perRequest: RateLimit;
}

export const DEFAULT_PUSH_LIMITS: PushLimits = {
  perDevice: { max: 20, windowMs: 60_000 },
  perRequest: { max: 1, windowMs: 5 * 60_000 },
};

export interface PushNotifierDeps {
  readonly clock: Clock;
  readonly directory: DeviceDirectory;
  readonly store: PushSubscriptionStore;
  readonly push: PushPort;
  readonly logger: Logger;
  readonly limits?: PushLimits;
  /** Writes one `push_sent` audit row per notified phone (M1-13). */
  readonly audit?: Pick<AuditSink, 'pushSent'>;
}

interface PendingRequest {
  readonly envelopeId: string;
  readonly userId: string;
  readonly from: string;
  readonly to: string;
  readonly expiresAt: number | null;
}

/**
 * The relay's {@link PendingRequestSink} (M0-12, D4, D5): a `cls: request` for a phone
 * with no live socket, or one that stayed unacked for 3 s, becomes a metadata-only Web
 * Push to each of that phone's subscriptions. Sending is fire-and-forget — the hub's
 * routing path never waits for it — and best-effort: failures are logged (never the
 * endpoint, D19) and swallowed; 404/410 delete the subscription.
 */
export class PushNotifier implements PendingRequestSink {
  readonly #limiter: FixedWindowRateLimiter;
  readonly #limits: PushLimits;
  readonly #inFlight = new Set<Promise<void>>();

  constructor(private readonly deps: PushNotifierDeps) {
    this.#limiter = new FixedWindowRateLimiter(deps.clock);
    this.#limits = deps.limits ?? DEFAULT_PUSH_LIMITS;
  }

  undelivered(envelope: UndeliveredEnvelope): void {
    if (envelope.cls !== 'request') return;
    this.#start(envelope, 'offline');
  }

  unacked(delivery: TrackedDelivery): void {
    // The router watches only `cls: request` deliveries to phones.
    if (!delivery.watch) return;
    this.#start(delivery, 'unacked');
  }

  /** Resolves once every push started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all([...this.#inFlight]);
  }

  #start(request: PendingRequest, reason: 'offline' | 'unacked'): void {
    const task = this.#notify(request, reason).catch((error: unknown) => {
      this.deps.logger.warn(
        { event: 'push_error', device: request.to, rid: request.envelopeId, err: errorName(error) },
        'push notification failed',
      );
    });
    this.#inFlight.add(task);
    void task.finally(() => this.#inFlight.delete(task));
  }

  async #notify(request: PendingRequest, reason: 'offline' | 'unacked'): Promise<void> {
    const log = { device: request.to, rid: request.envelopeId, reason };
    const ttlSeconds = pushTtlSeconds(request.expiresAt, this.deps.clock.now());
    if (ttlSeconds === 0) {
      this.deps.logger.debug({ event: 'push_skipped', ...log, why: 'expired' }, 'push skipped');
      return;
    }
    const devices = await this.deps.directory.listDevices(request.userId);
    const phone = devices.find((device) => device.id === request.to);
    if (phone === undefined || phone.kind !== 'phone' || phone.revokedAt !== null) return;
    const sender = devices.find((device) => device.id === request.from);

    const limits = this.#limits;
    if (!this.#limiter.hit(`rid:${request.envelopeId}`, limits.perRequest).allowed) return;
    if (!this.#limiter.hit(`device:${request.to}`, limits.perDevice).allowed) {
      this.deps.logger.warn({ event: 'push_skipped', ...log, why: 'rate_limited' }, 'push skipped');
      return;
    }

    const subscriptions = await this.deps.store.listForDevice(request.to);
    if (subscriptions.length === 0) {
      this.deps.logger.info(
        { event: 'push_skipped', ...log, why: 'no_subscription' },
        'push skipped',
      );
      return;
    }
    const message = {
      payload: encodePendingPayload(request.envelopeId, sender?.name ?? '', request.expiresAt),
      topic: pushTopic(request.envelopeId),
      ttlSeconds,
      urgency: 'high',
    } as const;
    let sent = false;
    await Promise.all(
      subscriptions.map(async (subscription) => {
        const result = await this.deps.push.send(subscription, message);
        const fields = {
          event: 'push_sent',
          ...log,
          subscription: subscription.id,
          result: result.kind,
        };
        if (result.kind === 'sent') {
          sent = true;
          this.deps.logger.info(fields, 'push sent');
        } else if (result.kind === 'gone') {
          await this.deps.store.remove(subscription.id);
          this.deps.logger.info(fields, 'push subscription gone, deleted');
        } else {
          await this.deps.store.markFailure(subscription.id, this.deps.clock.now());
          this.deps.logger.warn({ ...fields, status: result.status }, 'push failed');
        }
      }),
    );
    if (sent) this.deps.audit?.pushSent(request.userId, request.to);
  }
}

/** Error class name only: messages can quote endpoints or keys (D19). */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
