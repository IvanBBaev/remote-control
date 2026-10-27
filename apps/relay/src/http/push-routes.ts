import type { Clock } from '@remote-control/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AccountService } from '../core/account-service.js';
import { isKnownPushService, MAX_ENDPOINT_LENGTH } from '../core/push-endpoint.js';
import type { FixedWindowRateLimiter, RateLimit } from '../core/rate-limiter.js';
import { sessionCookie } from '../core/session-cookie.js';
import type { DeviceDirectory, DeviceIdentity } from '../ports/device-directory.js';
import type { PushSubscriptionStore } from '../ports/push-subscription-store.js';

/** Subscriptions kept per phone; registering one more drops the oldest. */
export const MAX_SUBSCRIPTIONS_PER_DEVICE = 5;

export interface PushRouteDeps {
  readonly accounts: AccountService;
  readonly directory: DeviceDirectory;
  readonly store: PushSubscriptionStore;
  readonly clock: Clock;
  readonly limiter: FixedWindowRateLimiter;
  /** VAPID public key served to the PWA; absent → no Web Push routes (APNs only). */
  readonly publicKey?: string | undefined;
  /** `true` → the native app may register APNs tokens (M4-05). */
  readonly apns?: boolean;
  /** Per-account limit on subscription requests. */
  readonly limit?: RateLimit;
  /** Which endpoints may be stored; default {@link isKnownPushService}. */
  readonly allowEndpoint?: (endpoint: string) => boolean;
}

const DEFAULT_LIMIT: RateLimit = { max: 30, windowMs: 60_000 };

const endpoint = z.string().min(1).max(MAX_ENDPOINT_LENGTH);
/** `PushSubscription.toJSON()`: keys are unpadded base64url (65-byte point, 16-byte secret). */
const subscriptionBody = z.object({
  endpoint,
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().regex(/^B[A-Za-z0-9_-]{86}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/),
  }),
});
const unsubscribeBody = z.object({ endpoint });
/** A native app's APNs device token (hex) and the environment its build talks to. */
const apnsToken = z.string().regex(/^[0-9a-f]{64,200}$/);
const apnsBody = z.object({
  token: apnsToken,
  environment: z.enum(['sandbox', 'production']),
});
const apnsDeleteBody = z.object({ token: apnsToken });

const BODY_LIMIT = 4096;

/**
 * Push registration for the PWA (Web Push, M0-12) and the native app (APNs, M4-05). Every
 * route needs the session cookie and a phone device bound to that session; state changes
 * also pass the origin guard (D8). Endpoints and tokens are capabilities: they are stored
 * but never returned or logged (D19).
 *
 * - `GET /api/push/key` → `{ publicKey }` (VAPID configured)
 * - `PUT /api/push/subscription` with `PushSubscription.toJSON()` → 204 (VAPID configured)
 * - `GET /api/push/subscription` → `{ subscriptions: [{ id, kind, createdAt, lastFailureAt }] }`
 * - `DELETE /api/push/subscription` with `{ endpoint }` → 204
 * - `PUT /api/push/apns` with `{ token, environment }` → 204 (APNs configured)
 * - `DELETE /api/push/apns` with `{ token }` → 204 (APNs configured)
 */
export function registerPushRoutes(app: FastifyInstance, deps: PushRouteDeps): void {
  const limit = deps.limit ?? DEFAULT_LIMIT;
  const allowEndpoint = deps.allowEndpoint ?? isKnownPushService;

  const phone = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<DeviceIdentity | undefined> => {
    const session = await deps.accounts.authenticate(sessionCookie.read(request.headers.cookie));
    if (!session.ok) {
      await reply
        .code(401)
        .header('cache-control', 'no-store')
        .header('set-cookie', sessionCookie.clear())
        .send({ error: 'unauthenticated' });
      return undefined;
    }
    const verdict = deps.limiter.hit(`push:${session.userId}`, limit);
    if (!verdict.allowed) {
      await reply
        .code(429)
        .header('retry-after', String(Math.ceil(verdict.retryAfterMs / 1000)))
        .send({ error: 'rate_limited' });
      return undefined;
    }
    const device = await deps.directory.phoneForSession(session.sessionId, session.userId);
    if (device === undefined) {
      await reply.code(403).header('cache-control', 'no-store').send({ error: 'no_phone' });
      return undefined;
    }
    return device;
  };

  const { publicKey } = deps;
  if (publicKey !== undefined) {
    app.get('/api/push/key', async (request, reply) => {
      const device = await phone(request, reply);
      if (device === undefined) return reply;
      return reply.header('cache-control', 'no-store').send({ publicKey });
    });
  }

  if (deps.apns === true) {
    app.put('/api/push/apns', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
      const device = await phone(request, reply);
      if (device === undefined) return reply;
      const parsed = apnsBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'bad_token' });
      const result = await deps.store.save(
        {
          kind: 'apns',
          userId: device.userId,
          deviceId: device.deviceId,
          endpoint: parsed.data.token,
          environment: parsed.data.environment,
        },
        MAX_SUBSCRIPTIONS_PER_DEVICE,
        deps.clock.now(),
      );
      if (result === 'taken') return reply.code(409).send({ error: 'endpoint_taken' });
      request.log.info(
        { event: 'push_subscribed', device: device.deviceId, kind: 'apns' },
        'apns token saved',
      );
      return reply.code(204).send();
    });

    app.delete('/api/push/apns', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
      const device = await phone(request, reply);
      if (device === undefined) return reply;
      const parsed = apnsDeleteBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'bad_token' });
      if (await deps.store.removeEndpoint(device.deviceId, parsed.data.token)) {
        request.log.info(
          { event: 'push_unsubscribed', device: device.deviceId, kind: 'apns' },
          'apns token deleted',
        );
      }
      return reply.code(204).send();
    });
  }

  if (publicKey !== undefined) {
    app.put('/api/push/subscription', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
      const device = await phone(request, reply);
      if (device === undefined) return reply;
      const parsed = subscriptionBody.safeParse(request.body);
      if (!parsed.success || !allowEndpoint(parsed.data.endpoint)) {
        return reply.code(400).send({ error: 'bad_subscription' });
      }
      const result = await deps.store.save(
        {
          kind: 'webpush',
          userId: device.userId,
          deviceId: device.deviceId,
          endpoint: parsed.data.endpoint,
          p256dh: parsed.data.keys.p256dh,
          auth: parsed.data.keys.auth,
        },
        MAX_SUBSCRIPTIONS_PER_DEVICE,
        deps.clock.now(),
      );
      if (result === 'taken') return reply.code(409).send({ error: 'endpoint_taken' });
      request.log.info(
        { event: 'push_subscribed', device: device.deviceId },
        'push subscription saved',
      );
      return reply.code(204).send();
    });
  }

  app.get('/api/push/subscription', async (request, reply) => {
    const device = await phone(request, reply);
    if (device === undefined) return reply;
    const subscriptions = (await deps.store.listForDevice(device.deviceId)).map((row) => ({
      id: row.id,
      kind: row.kind,
      createdAt: row.createdAt,
      lastFailureAt: row.lastFailureAt,
    }));
    return reply.header('cache-control', 'no-store').send({ subscriptions });
  });

  app.delete('/api/push/subscription', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const device = await phone(request, reply);
    if (device === undefined) return reply;
    const parsed = unsubscribeBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_subscription' });
    const removed = await deps.store.removeEndpoint(device.deviceId, parsed.data.endpoint);
    if (removed) {
      request.log.info(
        { event: 'push_unsubscribed', device: device.deviceId },
        'push subscription deleted',
      );
    }
    return reply.code(204).send();
  });
}
