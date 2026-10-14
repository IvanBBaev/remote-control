import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { PairingService } from '../core/pairing-service.js';
import type { RateLimit } from '../core/rate-limiter.js';
import type { DeviceAuth, RouteLimit } from './device-auth.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Rate limits of the enrolment and pairing endpoints; in process, per replica (ADR 0016). */
export interface PairingRateLimits {
  /** `POST /api/devices/phone`, per account. */
  readonly bindPhone: RateLimit;
  /** `POST /api/agents`, per account. */
  readonly enrolAgent: RateLimit;
  /** `POST /api/agents/token`, per agent. */
  readonly rotateToken: RateLimit;
  /** `POST /api/pairings`, per agent. */
  readonly openSlot: RateLimit;
  /** Status, complete, fail and cancel of a slot, per agent (the agent polls status). */
  readonly slot: RateLimit;
  /** `POST /api/pairings/join`, per account. */
  readonly joinSlot: RateLimit;
}

export const DEFAULT_PAIRING_RATE_LIMITS: PairingRateLimits = {
  bindPhone: { max: 30, windowMs: HOUR },
  enrolAgent: { max: 10, windowMs: HOUR },
  rotateToken: { max: 10, windowMs: HOUR },
  openSlot: { max: 20, windowMs: HOUR },
  slot: { max: 240, windowMs: MINUTE },
  joinSlot: { max: 10, windowMs: MINUTE },
};

export interface PairingRouteDeps {
  readonly pairing: PairingService;
  readonly auth: DeviceAuth;
  readonly limits: PairingRateLimits;
}

const BODY_LIMIT = 4 * 1024;
/** A 32-byte value in unpadded base64url. */
const hash32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** The HTTP layer may use Node's Buffer; it decodes to a plain `Uint8Array` for the core. */
const codeHashBytes = (text: string) => new Uint8Array(Buffer.from(text, 'base64url'));
const deviceName = z.string().trim().min(1).max(64);
const uuid = z.uuid();

const phoneBody = z.strictObject({ name: deviceName, deviceId: uuid.optional() });
const agentBody = z.strictObject({ name: deviceName });
const codeBody = z.strictObject({ codeHash: hash32 });
const slotParams = z.strictObject({ slotId: uuid });

const STATUS = {
  unknown_slot: 404,
  unknown_device: 404,
  expired: 410,
  closed: 410,
  already_joined: 409,
  not_joined: 409,
  device_cap: 409,
  code_in_use: 409,
} as const;

/**
 * Enrolment and pairing (02 §5.3, §5.5, D6, D25). Phone routes use the login session
 * (cookie, Origin + `X-RC-Client`, D8); agent routes use the bearer token. The pairing
 * code and the XXpsk0 messages never reach these routes: the phone sends a hash of the
 * code, and the handshake travels as ordinary WebSocket envelopes (I3). Failures answer
 * a reason code and are logged as `event` + `reason` only (D19).
 */
export function registerPairingRoutes(app: FastifyInstance, deps: PairingRouteDeps): void {
  const { pairing, auth, limits } = deps;
  const limit = (key: string, value: RateLimit): RouteLimit => ({ key, limit: value });

  function parse<T>(
    schema: z.ZodType<T>,
    value: unknown,
    request: FastifyRequest,
    reply: FastifyReply,
  ): T | undefined {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    request.log.warn({ event: 'pairing_bad_request', outcome: 'rejected' }, 'invalid request');
    void reply.code(400).send({ error: 'bad_request' });
    return undefined;
  }

  function refuse(
    request: FastifyRequest,
    reply: FastifyReply,
    event: string,
    reason: keyof typeof STATUS,
  ): FastifyReply {
    request.log.warn({ event, outcome: 'rejected', reason }, 'pairing rejected');
    return reply.code(STATUS[reason]).send({ error: reason });
  }

  void app.register(
    (scope, _options, done) => {
      scope.addHook('onRequest', async (_request, reply) => {
        void reply.header('cache-control', 'no-store');
      });
      const post = { bodyLimit: BODY_LIMIT };

      scope.post('/devices/phone', post, async (request, reply) => {
        const session = await auth.session(request, reply, limit('bind', limits.bindPhone));
        if (session === undefined) return reply;
        const body = parse(phoneBody, request.body, request, reply);
        if (body === undefined) return reply;
        const result = await pairing.bindPhone(session, body.name, body.deviceId);
        if (!result.ok) return refuse(request, reply, 'phone_bind', result.reason);
        request.log.info(
          {
            event: 'phone_bind',
            outcome: 'ok',
            user_id: session.userId,
            device_id: result.deviceId,
            created: result.created,
          },
          'phone bound',
        );
        return reply.code(result.created ? 201 : 200).send({ deviceId: result.deviceId });
      });

      scope.post('/agents', post, async (request, reply) => {
        const phone = await auth.phone(request, reply, limit('enrol', limits.enrolAgent));
        if (phone === undefined) return reply;
        const body = parse(agentBody, request.body, request, reply);
        if (body === undefined) return reply;
        const result = await pairing.enrolAgent(phone.userId, body.name);
        if (!result.ok) return refuse(request, reply, 'agent_enrol', result.reason);
        request.log.info(
          {
            event: 'agent_enrol',
            outcome: 'ok',
            user_id: phone.userId,
            device_id: result.deviceId,
          },
          'agent enrolled',
        );
        return reply.code(201).send({ deviceId: result.deviceId, enrollToken: result.enrollToken });
      });

      scope.post('/agents/token', post, async (request, reply) => {
        const agent = await auth.agent(request, reply, limit('rotate', limits.rotateToken));
        if (agent === undefined) return reply;
        const token = await pairing.rotateToken(agent.identity, agent.token);
        // Only a concurrent rotation of the same token lands here.
        if (token === null) {
          return reply.code(401).send({ error: 'unauthenticated' });
        }
        request.log.info(
          { event: 'agent_token_rotated', outcome: 'ok', device_id: agent.identity.deviceId },
          'agent token rotated',
        );
        // The agent needs its account id for the pairing and session prologues (D3, D6).
        return { token, userId: agent.identity.userId };
      });

      scope.post('/pairings', post, async (request, reply) => {
        const agent = await auth.agent(request, reply, limit('open', limits.openSlot));
        if (agent === undefined) return reply;
        const body = parse(codeBody, request.body, request, reply);
        if (body === undefined) return reply;
        const result = await pairing.openSlot(agent.identity, codeHashBytes(body.codeHash));
        if (!result.ok) return refuse(request, reply, 'pairing_open', result.reason);
        request.log.info(
          {
            event: 'pairing_open',
            outcome: 'ok',
            device_id: agent.identity.deviceId,
            slot_id: result.slotId,
          },
          'pairing slot opened',
        );
        return reply.code(201).send({ slotId: result.slotId, expiresAt: result.expiresAt });
      });

      scope.post('/pairings/join', post, async (request, reply) => {
        const phone = await auth.phone(request, reply, limit('join', limits.joinSlot));
        if (phone === undefined) return reply;
        const body = parse(codeBody, request.body, request, reply);
        if (body === undefined) return reply;
        const result = await pairing.joinSlot(phone, codeHashBytes(body.codeHash));
        if (!result.ok) return refuse(request, reply, 'pairing_join', result.reason);
        request.log.info(
          {
            event: 'pairing_join',
            outcome: 'ok',
            user_id: phone.userId,
            device_id: phone.deviceId,
            slot_id: result.slotId,
          },
          'pairing slot joined',
        );
        return {
          slotId: result.slotId,
          agentDeviceId: result.agentDeviceId,
          expiresAt: result.expiresAt,
        };
      });

      scope.get('/pairings/:slotId', async (request, reply) => {
        const agent = await auth.agent(request, reply, limit('slot', limits.slot));
        if (agent === undefined) return reply;
        const params = parse(slotParams, request.params, request, reply);
        if (params === undefined) return reply;
        const status = await pairing.status(agent.identity, params.slotId);
        if (status === undefined) return refuse(request, reply, 'pairing_status', 'unknown_slot');
        return status;
      });

      scope.post('/pairings/:slotId/complete', post, async (request, reply) => {
        const agent = await auth.agent(request, reply, limit('slot', limits.slot));
        if (agent === undefined) return reply;
        const params = parse(slotParams, request.params, request, reply);
        if (params === undefined) return reply;
        const result = await pairing.complete(agent.identity, params.slotId);
        if (!result.ok) return refuse(request, reply, 'pairing_complete', result.reason);
        request.log.info(
          {
            event: 'pairing_complete',
            outcome: 'ok',
            device_id: agent.identity.deviceId,
            peer_device_id: result.phoneDeviceId,
          },
          'pairing recorded',
        );
        return { pairingId: result.pairingId, phoneDeviceId: result.phoneDeviceId };
      });

      scope.post('/pairings/:slotId/fail', post, async (request, reply) => {
        const agent = await auth.agent(request, reply, limit('slot', limits.slot));
        if (agent === undefined) return reply;
        const params = parse(slotParams, request.params, request, reply);
        if (params === undefined) return reply;
        const result = await pairing.fail(agent.identity, params.slotId);
        if (!result.ok) return refuse(request, reply, 'pairing_fail', result.reason);
        request.log.warn(
          {
            event: 'pairing_handshake_failed',
            outcome: result.state,
            device_id: agent.identity.deviceId,
            failed_attempts: result.failedAttempts,
          },
          'pairing handshake failed',
        );
        return { state: result.state, failedAttempts: result.failedAttempts };
      });

      scope.delete('/pairings/:slotId', async (request, reply) => {
        const agent = await auth.agent(request, reply, limit('slot', limits.slot));
        if (agent === undefined) return reply;
        const params = parse(slotParams, request.params, request, reply);
        if (params === undefined) return reply;
        if (!(await pairing.cancel(agent.identity, params.slotId))) {
          return refuse(request, reply, 'pairing_cancel', 'unknown_slot');
        }
        return reply.code(204).send();
      });

      done();
    },
    { prefix: '/api' },
  );
}
