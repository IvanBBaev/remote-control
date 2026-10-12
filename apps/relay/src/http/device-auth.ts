import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AccountService, Authenticated } from '../core/account-service.js';
import { agentTokenHash } from '../core/pairing-service.js';
import type { FixedWindowRateLimiter, RateLimit } from '../core/rate-limiter.js';
import { sessionCookie } from '../core/session-cookie.js';
import type { DeviceDirectory, DeviceIdentity } from '../ports/device-directory.js';

/** Longest bearer token accepted (the real ones are 43 characters). */
const MAX_TOKEN_LENGTH = 512;
const BEARER = /^Bearer ([\x21-\x7e]+)$/;

/** A per-route rate limit; `key` names the counter (per user or per agent). */
export interface RouteLimit {
  readonly key: string;
  readonly limit: RateLimit;
}

export interface DeviceAuthDeps {
  readonly accounts: AccountService;
  readonly directory: DeviceDirectory;
  readonly limiter: FixedWindowRateLimiter;
  readonly now: () => number;
}

export function rejectLimited(reply: FastifyReply, retryAfterMs: number): FastifyReply {
  return reply
    .code(429)
    .header('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
    .send({ error: 'rate_limited' });
}

/**
 * Request authentication for the device APIs: a login session (cookie) for the phone, a
 * bearer token (only its SHA-256 is looked up) for an agent. A rejection is sent here and
 * logged as `event` + `reason` only — never the token or cookie (D19).
 */
export function deviceAuth(deps: DeviceAuthDeps) {
  async function session(
    request: FastifyRequest,
    reply: FastifyReply,
    limit: RouteLimit,
  ): Promise<Authenticated | undefined> {
    const result = await deps.accounts.authenticate(sessionCookie.read(request.headers.cookie));
    if (!result.ok) {
      request.log.info(
        { event: 'session', outcome: 'rejected', reason: result.reason },
        'no session',
      );
      await reply.code(401).send({ error: 'unauthenticated' });
      return undefined;
    }
    const hit = deps.limiter.hit(`${limit.key}:user:${result.userId}`, limit.limit);
    if (!hit.allowed) {
      await rejectLimited(reply, hit.retryAfterMs);
      return undefined;
    }
    return result;
  }

  return {
    /** A live login session, before it is bound to a phone. */
    session,

    /** The phone bound to the request's login session (`POST /api/devices/phone` binds it). */
    async phone(
      request: FastifyRequest,
      reply: FastifyReply,
      limit: RouteLimit,
    ): Promise<DeviceIdentity | undefined> {
      const authenticated = await session(request, reply, limit);
      if (authenticated === undefined) return undefined;
      const phone = await deps.directory.phoneForSession(
        authenticated.sessionId,
        authenticated.userId,
      );
      if (phone === undefined) {
        request.log.info({ event: 'device', outcome: 'rejected', reason: 'no_device' }, 'no phone');
        await reply.code(409).send({ error: 'no_device' });
      }
      return phone;
    },

    /** The live agent behind `Authorization: Bearer`, and the presented token (for rotation). */
    async agent(
      request: FastifyRequest,
      reply: FastifyReply,
      limit: RouteLimit,
    ): Promise<{ readonly identity: DeviceIdentity; readonly token: string } | undefined> {
      const header = request.headers.authorization;
      const token = header === undefined ? undefined : BEARER.exec(header)?.[1];
      const identity =
        token === undefined || token.length > MAX_TOKEN_LENGTH
          ? undefined
          : await deps.directory.authenticateAgent(await agentTokenHash(token), deps.now());
      if (token === undefined || identity === undefined) {
        request.log.info(
          { event: 'agent_auth', outcome: 'rejected', reason: 'unauthenticated' },
          'no agent',
        );
        await reply.code(401).send({ error: 'unauthenticated' });
        return undefined;
      }
      const hit = deps.limiter.hit(`${limit.key}:agent:${identity.deviceId}`, limit.limit);
      if (!hit.allowed) {
        await rejectLimited(reply, hit.retryAfterMs);
        return undefined;
      }
      return { identity, token };
    },
  };
}

export type DeviceAuth = ReturnType<typeof deviceAuth>;
