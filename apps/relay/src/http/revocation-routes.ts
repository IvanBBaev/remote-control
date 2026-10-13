import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { RateLimit } from '../core/rate-limiter.js';
import type { RevocationService } from '../core/revocation-service.js';
import { sessionCookie } from '../core/session-cookie.js';
import type { DeviceAuth } from './device-auth.js';

const MINUTE = 60_000;

/** Per-account (phone) or per-agent limit of revocation and deletion. */
export const DEFAULT_REVOCATION_RATE_LIMIT: RateLimit = { max: 30, windowMs: MINUTE };

export interface RevocationRouteDeps {
  readonly revocations: RevocationService;
  readonly auth: DeviceAuth;
  readonly limit: RateLimit;
}

const deviceParams = z.strictObject({ deviceId: z.uuid() });

/**
 * Revocation and account deletion (M1-10, 02 §5.9):
 * - `DELETE /api/devices/:deviceId` — the phone (cookie) revokes any device of its
 *   account, an agent (`Authorization: Bearer`) one of the account's phones;
 * - `DELETE /api/account` — the phone deletes the account after a UV assertion over
 *   `accountDeletionHash(userId)` through `/api/decisions/*`;
 * - `GET /api/agents/me` — whether the agent's token still works (401 once revoked or
 *   deleted), which is how an offline agent learns of it on its next connect.
 */
export function registerRevocationRoutes(app: FastifyInstance, deps: RevocationRouteDeps): void {
  const { revocations, auth } = deps;
  const limit = { key: 'revocation', limit: deps.limit };

  void app.register(
    (scope, _options, done) => {
      scope.addHook('onRequest', async (_request, reply) => {
        void reply.header('cache-control', 'no-store');
      });

      scope.delete('/devices/:deviceId', async (request, reply) => {
        const params = deviceParams.safeParse(request.params);
        const bearer = request.headers.authorization !== undefined;
        const actor = bearer
          ? (await auth.agent(request, reply, limit))?.identity
          : await auth.phone(request, reply, limit);
        if (actor === undefined) return reply;
        if (!params.success) return reply.code(404).send({ error: 'unknown_device' });
        const result = await revocations.revoke(actor, params.data.deviceId);
        if (!result.ok) {
          request.log.info(
            { event: 'device_revoke', outcome: 'rejected', reason: result.reason },
            'revoke refused',
          );
          return reply.code(404).send({ error: result.reason });
        }
        return reply.code(204).send();
      });

      scope.delete('/account', async (request, reply) => {
        const phone = await auth.phone(request, reply, limit);
        if (phone === undefined) return reply;
        const result = await revocations.deleteAccount(phone);
        if (!result.ok) {
          request.log.info(
            { event: 'account_delete', outcome: 'rejected', reason: result.reason },
            'account deletion refused',
          );
          return reply
            .code(result.reason === 'not_verified' ? 403 : 404)
            .send({ error: result.reason });
        }
        return reply.code(204).header('set-cookie', sessionCookie.clear()).send();
      });

      scope.get('/agents/me', async (request, reply) => {
        const agent = await auth.agent(request, reply, limit);
        if (agent === undefined) return reply;
        return { deviceId: agent.identity.deviceId, userId: agent.identity.userId };
      });

      done();
    },
    { prefix: '/api' },
  );
}
