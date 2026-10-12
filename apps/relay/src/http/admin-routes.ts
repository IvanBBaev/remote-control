import { sha256, utf8 } from '@remote-control/crypto';
import type { Clock } from '@remote-control/protocol';
import type { FastifyInstance } from 'fastify';

import type { FixedWindowRateLimiter, RateLimit } from '../core/rate-limiter.js';
import type { AdminStatsStore } from '../ports/audit-log.js';
import type { HubPort } from '../ports/hub.js';
import { rejectLimited } from './device-auth.js';

/** Days of `pushesPerDay` returned, today (UTC) included. */
export const COUNTER_DAYS = 7;
const DAY_MS = 86_400_000;
const MAX_TOKEN_LENGTH = 256;
const BEARER = /^Bearer ([\x21-\x7e]+)$/;
/** Per-IP requests, rejected ones included, so the token cannot be guessed online. */
export const DEFAULT_ADMIN_LIMIT: RateLimit = { max: 10, windowMs: 60_000 };

export interface AdminRouteDeps {
  /** SHA-256 of `RC_ADMIN_TOKEN`; only digests are compared. */
  readonly tokenHash: Uint8Array;
  readonly stats: AdminStatsStore;
  readonly hub: HubPort;
  readonly clock: Clock;
  readonly limiter: FixedWindowRateLimiter;
  readonly limit?: RateLimit;
}

/**
 * Owner-only counters (M1-13, 03 W12): `GET /api/admin/counters` with
 * `Authorization: Bearer <RC_ADMIN_TOKEN>` →
 * `{ users, devices: { phone, agent }, online: { phone, agent }, pushesPerDay: [{ day, count }] }`.
 * Counts only — no ids, names or bodies (D19). A wrong token is a 401 logged as
 * `event` + `reason`, never the token.
 */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  const limit = deps.limit ?? DEFAULT_ADMIN_LIMIT;

  app.get('/api/admin/counters', async (request, reply) => {
    const hit = deps.limiter.hit(`admin:ip:${request.ip}`, limit);
    if (!hit.allowed) return rejectLimited(reply, hit.retryAfterMs);
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
    if (
      token === undefined ||
      token.length > MAX_TOKEN_LENGTH ||
      !equalBytes(await sha256(utf8(token)), deps.tokenHash)
    ) {
      request.log.warn({ event: 'admin_auth', outcome: 'rejected' }, 'admin token rejected');
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    const now = deps.clock.now();
    const since = Math.floor(now / DAY_MS) * DAY_MS - (COUNTER_DAYS - 1) * DAY_MS;
    const stats = await deps.stats.stats(since);
    return reply.header('cache-control', 'no-store').send({
      users: stats.users,
      devices: stats.devices,
      online: { phone: deps.hub.online('phone'), agent: deps.hub.online('agent') },
      pushesPerDay: stats.pushesPerDay,
    });
  });
}

/** Constant-time over equal-length digests. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
