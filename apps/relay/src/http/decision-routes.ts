import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { DecisionVerifier } from '../core/decision-verifier.js';
import type { RateLimit } from '../core/rate-limiter.js';
import type { DeviceAuth } from './device-auth.js';

const MINUTE = 60_000;

/** Per-account limit of the decision endpoints (two calls per approval). */
export const DEFAULT_DECISION_RATE_LIMIT: RateLimit = { max: 120, windowMs: MINUTE };

export interface DecisionRouteDeps {
  readonly verifier: DecisionVerifier;
  readonly auth: DeviceAuth;
  readonly limit: RateLimit;
}

const BODY_LIMIT = 16 * 1024;
const b64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(8192);
const challengeBody = z.strictObject({ decisionHash: z.string().regex(/^[0-9a-f]{64}$/) });
const verifyBody = z.strictObject({
  response: z.looseObject({
    id: b64url,
    rawId: b64url,
    type: z.literal('public-key'),
    clientExtensionResults: z.looseObject({}),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
    response: z.looseObject({
      clientDataJSON: b64url,
      authenticatorData: b64url,
      signature: b64url,
      userHandle: b64url.optional(),
    }),
  }),
});

const STATUS = {
  replayed: 409,
  busy: 503,
  unknown_challenge: 400,
  unknown_credential: 401,
  verification_failed: 401,
} as const;

/**
 * `/api/decisions/*` (D7, 02 §5.4): the phone gets WebAuthn options whose challenge is
 * the decision hash, then posts the UV assertion; the relay remembers the verified hash
 * and admits the matching `cls: command` envelope. Phone session only (D8). Logged as
 * `event` + `reason` only — never the hash, assertion or credential (D19).
 */
export function registerDecisionRoutes(app: FastifyInstance, deps: DecisionRouteDeps): void {
  const { verifier, auth } = deps;
  const limit = { key: 'decision', limit: deps.limit };

  function refuse(
    request: FastifyRequest,
    reply: FastifyReply,
    event: string,
    reason: keyof typeof STATUS,
  ): FastifyReply {
    request.log.warn({ event, outcome: 'rejected', reason }, 'decision rejected');
    return reply.code(STATUS[reason]).send({ error: reason });
  }

  function badRequest(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    request.log.warn({ event: 'decision_bad_request', outcome: 'rejected' }, 'invalid body');
    return reply.code(400).send({ error: 'bad_request' });
  }

  void app.register(
    (scope, _options, done) => {
      scope.addHook('onRequest', async (_request, reply) => {
        void reply.header('cache-control', 'no-store');
      });
      const post = { bodyLimit: BODY_LIMIT };

      scope.post('/challenge', post, async (request, reply) => {
        const phone = await auth.phone(request, reply, limit);
        if (phone === undefined) return reply;
        const body = challengeBody.safeParse(request.body);
        if (!body.success) return badRequest(request, reply);
        const result = await verifier.challenge(phone, body.data.decisionHash);
        if (!result.ok) return refuse(request, reply, 'decision_challenge', result.reason);
        return result.options;
      });

      scope.post('/verify', post, async (request, reply) => {
        const phone = await auth.phone(request, reply, limit);
        if (phone === undefined) return reply;
        const body = verifyBody.safeParse(request.body);
        if (!body.success) return badRequest(request, reply);
        const result = await verifier.verify(phone, body.data.response);
        if (!result.ok) return refuse(request, reply, 'decision_verify', result.reason);
        request.log.info(
          {
            event: 'decision_verified',
            outcome: 'ok',
            user_id: phone.userId,
            device_id: phone.deviceId,
          },
          'decision verified',
        );
        return { decisionHash: result.decisionHash, verifiedUntil: result.verifiedUntil };
      });

      done();
    },
    { prefix: '/api/decisions' },
  );
}
