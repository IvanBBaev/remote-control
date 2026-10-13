import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Clock } from '@remote-control/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { checkOrigin } from '../core/origin-guard.js';
import { isKnownPushService, MAX_ENDPOINT_LENGTH } from '../core/push-endpoint.js';
import type { FixedWindowRateLimiter, RateLimit } from '../core/rate-limiter.js';
import type { PushPort } from '../ports/push.js';
import type { Timer, TimerHandle } from '../ports/timer.js';

export interface SpikeRouteDeps {
  /** Directory with the spike page (`apps/relay/spike`). */
  readonly dir: string;
  readonly push: PushPort;
  /** VAPID public key, the page's `applicationServerKey`. */
  readonly publicKey: string;
  /** `RC_ORIGIN`; the push request must come from the page itself. */
  readonly origin: string;
  readonly clock: Clock;
  readonly timer: Timer;
  readonly limiter: FixedWindowRateLimiter;
  /** Which endpoints may be pushed to; default {@link isKnownPushService}. */
  readonly allowEndpoint?: (endpoint: string) => boolean;
}

/** Per-IP limit on scheduled test pushes. */
export const SPIKE_PUSH_LIMIT: RateLimit = { max: 10, windowMs: 60_000 };
/** Test pushes waiting for their delay, across all callers. */
export const MAX_PENDING_SPIKE_PUSHES = 20;
/** Longest delay a test push may ask for: enough to close the app and lock the phone. */
export const MAX_SPIKE_DELAY_SECONDS = 120;

/** Served files: published path → file name and content type. */
const FILES: Readonly<Record<string, readonly [string, string]>> = {
  '/spike/': ['index.html', 'text/html; charset=utf-8'],
  '/spike/spike.js': ['spike.js', 'text/javascript; charset=utf-8'],
  '/spike/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/spike/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/spike/icon.svg': ['icon.svg', 'image/svg+xml'],
};

const pushBody = z.object({
  subscription: z.object({
    endpoint: z.string().min(1).max(MAX_ENDPOINT_LENGTH),
    keys: z.object({
      p256dh: z.string().regex(/^B[A-Za-z0-9_-]{86}$/),
      auth: z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/),
    }),
  }),
  /** Opaque to the relay: the page encrypts it with a key only the phone holds (I1). */
  payload: z.string().min(1).max(2048),
  delaySeconds: z.number().int().min(0).max(MAX_SPIKE_DELAY_SECONDS),
});

const header = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/**
 * The M0-03 device feasibility spike (05 W1): a throwaway page under `/spike/` and one
 * endpoint that sends the page a test push after a delay, so the owner can close the
 * installed app and lock the phone first. Enabled only with `RC_SPIKE=1` and VAPID keys;
 * removed once `docs/verification/device-spike.md` records the verdict.
 *
 * - `GET /spike/`, `/spike/requests/:id` → the page (the second is the deep-link target)
 * - `GET /api/spike/key` → `{ publicKey }`
 * - `POST /api/spike/push` with `{ subscription, payload, delaySeconds }` → 202
 *
 * The payload is ciphertext the relay cannot read and is held in memory only until its
 * timer fires (or the relay closes); nothing is written anywhere, endpoints are never logged.
 */
export function registerSpikeRoutes(app: FastifyInstance, deps: SpikeRouteDeps): void {
  const allowEndpoint = deps.allowEndpoint ?? isKnownPushService;
  const files = new Map(
    Object.entries(FILES).map(([path, [name, type]]) => [
      path,
      { body: readFileSync(join(deps.dir, name)), type },
    ]),
  );
  const pending = new Set<TimerHandle>();

  app.addHook('onClose', (_instance, done) => {
    for (const handle of pending) handle.cancel();
    pending.clear();
    done();
  });

  const page = files.get('/spike/')!;
  for (const [path, file] of files) {
    app.get(path, async (_request, reply) =>
      reply.header('cache-control', 'no-cache').type(file.type).send(file.body),
    );
  }
  app.get('/spike', async (_request, reply) => reply.redirect('/spike/'));
  app.get('/spike/requests/:id', async (_request, reply) =>
    reply.header('cache-control', 'no-cache').type(page.type).send(page.body),
  );

  app.get('/api/spike/key', async (_request, reply) =>
    reply.header('cache-control', 'no-store').send({ publicKey: deps.publicKey }),
  );

  app.post('/api/spike/push', { bodyLimit: 4096 }, async (request, reply) => {
    if (originFailure(request, deps.origin)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const verdict = deps.limiter.hit(`spike:${request.ip}`, SPIKE_PUSH_LIMIT);
    if (!verdict.allowed) {
      return reply
        .code(429)
        .header('retry-after', String(Math.ceil(verdict.retryAfterMs / 1000)))
        .send({ error: 'rate_limited' });
    }
    const parsed = pushBody.safeParse(request.body);
    if (!parsed.success || !allowEndpoint(parsed.data.subscription.endpoint)) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    if (pending.size >= MAX_PENDING_SPIKE_PUSHES) {
      return reply.code(503).send({ error: 'busy' });
    }
    const { subscription, payload, delaySeconds } = parsed.data;
    const target = { endpoint: subscription.endpoint, ...subscription.keys };
    const handle = deps.timer.after(delaySeconds * 1000, () => {
      pending.delete(handle);
      void deps.push
        .send(target, { payload, topic: 'spike', ttlSeconds: 300, urgency: 'high' })
        .then((result) => {
          app.log.info({ event: 'spike_push', result: result.kind }, 'spike push sent');
        });
    });
    pending.add(handle);
    return reply.code(202).send({ sendAt: deps.clock.now() + delaySeconds * 1000 });
  });
}

function originFailure(request: FastifyRequest, origin: string): boolean {
  const failure = checkOrigin(
    {
      origin: header(request.headers.origin),
      secFetchSite: header(request.headers['sec-fetch-site']),
      client: header(request.headers['x-rc-client']),
    },
    origin,
  );
  if (failure !== null) {
    request.log.warn({ event: 'origin_rejected', reason: failure }, 'request rejected');
  }
  return failure !== null;
}
