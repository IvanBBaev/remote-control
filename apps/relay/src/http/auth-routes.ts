import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AccountService, Failure, IssuedSession } from '../core/account-service.js';
import type { FixedWindowRateLimiter, RateLimit, RateLimitResult } from '../core/rate-limiter.js';
import { sessionCookie } from '../core/session-cookie.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Rate limits of the account endpoints (02 §5.7); in process, per replica (ADR 0016). */
export interface AuthRateLimits {
  /** Every `/api/auth/*` request, per IP. */
  readonly anyPerIp: RateLimit;
  /** `register/options`, per IP. */
  readonly registerPerIp: RateLimit;
  /** `login/verify`, per IP and per account. */
  readonly loginPerIp: RateLimit;
  readonly loginPerUser: RateLimit;
  /** `recovery/options`, per IP and per account. */
  readonly recoveryPerIp: RateLimit;
  readonly recoveryPerUser: RateLimit;
  /** Authenticated requests (`session`, `logout`), per account. */
  readonly sessionPerUser: RateLimit;
}

export const DEFAULT_AUTH_RATE_LIMITS: AuthRateLimits = {
  anyPerIp: { max: 60, windowMs: MINUTE },
  registerPerIp: { max: 5, windowMs: HOUR },
  loginPerIp: { max: 20, windowMs: HOUR },
  loginPerUser: { max: 20, windowMs: HOUR },
  recoveryPerIp: { max: 5, windowMs: HOUR },
  recoveryPerUser: { max: 5, windowMs: HOUR },
  sessionPerUser: { max: 120, windowMs: MINUTE },
};

export interface AuthRouteDeps {
  readonly service: AccountService;
  readonly limiter: FixedWindowRateLimiter;
  readonly limits: AuthRateLimits;
}

/** WebAuthn JSON is checked for shape here and cryptographically by the library. */
const b64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(8192);
const credentialBase = {
  id: b64url,
  rawId: b64url,
  type: z.literal('public-key'),
  clientExtensionResults: z.looseObject({}),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
};
const registrationResponse = z.looseObject({
  ...credentialBase,
  response: z.looseObject({ clientDataJSON: b64url, attestationObject: b64url }),
});
const authenticationResponse = z.looseObject({
  ...credentialBase,
  response: z.looseObject({
    clientDataJSON: b64url,
    authenticatorData: b64url,
    signature: b64url,
    userHandle: b64url.optional(),
  }),
});
const registerOptionsBody = z.strictObject({
  inviteCode: z.string().min(1).max(64),
  displayName: z.string().trim().min(1).max(64).optional(),
});
const recoveryOptionsBody = z.strictObject({ recoveryCode: z.string().min(1).max(64) });

const BODY_LIMIT = 16 * 1024;

type Reply = FastifyReply;

function rejectLimited(reply: Reply, retryAfterMs: number): Reply {
  return reply
    .code(429)
    .header('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
    .send({ error: 'rate_limited' });
}

function setSession(reply: Reply, session: IssuedSession): Reply {
  return reply.header('set-cookie', sessionCookie.serialize(session.token, session.maxAgeSec));
}

/**
 * `/api/auth/*`: passkey registration (invite required), discoverable login, recovery,
 * session check and logout (D8). Failures answer a reason code and are logged as
 * `event` + `reason` only — never a token, code, challenge or credential (D19).
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { service, limiter, limits } = deps;

  const limited = (key: string, limit: RateLimit): RateLimitResult => limiter.hit(key, limit);
  const userGuard = (flow: string, limit: RateLimit) => (userId: string) =>
    limited(`${flow}:user:${userId}`, limit);

  function fail(
    request: FastifyRequest,
    reply: Reply,
    event: string,
    failure: Failure<string>,
    status: number,
  ): Reply {
    request.log.warn({ event, outcome: 'rejected', reason: failure.reason }, 'auth rejected');
    if (failure.reason === 'rate_limited' && 'retryAfterMs' in failure) {
      return rejectLimited(reply, failure.retryAfterMs);
    }
    return reply.code(status).send({ error: failure.reason });
  }

  function parse<T>(schema: z.ZodType<T>, request: FastifyRequest, reply: Reply): T | undefined {
    const parsed = schema.safeParse(request.body);
    if (parsed.success) return parsed.data;
    request.log.warn({ event: 'auth_bad_request', outcome: 'rejected' }, 'invalid body');
    void reply.code(400).send({ error: 'bad_request' });
    return undefined;
  }

  void app.register(
    (scope, _options, done) => {
      scope.addHook('onRequest', async (request, reply) => {
        void reply.header('cache-control', 'no-store');
        const result = limited(`auth:ip:${request.ip}`, limits.anyPerIp);
        if (!result.allowed) await rejectLimited(reply, result.retryAfterMs);
      });

      const post = { bodyLimit: BODY_LIMIT };

      scope.post('/register/options', post, async (request, reply) => {
        const ip = limited(`register:ip:${request.ip}`, limits.registerPerIp);
        if (!ip.allowed) return rejectLimited(reply, ip.retryAfterMs);
        const body = parse(registerOptionsBody, request, reply);
        if (body === undefined) return reply;
        const result = await service.startRegistration(body.inviteCode, body.displayName ?? null);
        if (!result.ok) return fail(request, reply, 'register', result, 403);
        return result.options;
      });

      scope.post('/register/verify', post, async (request, reply) => {
        const body = parse(registrationResponse, request, reply);
        if (body === undefined) return reply;
        const result = await service.finishRegistration(body);
        if (!result.ok) {
          return fail(
            request,
            reply,
            'register',
            result,
            result.reason === 'invalid_invite' ? 403 : 400,
          );
        }
        request.log.info(
          { event: 'register', outcome: 'ok', user_id: result.userId },
          'registered',
        );
        return setSession(reply, result.session).send({
          userId: result.userId,
          recoveryCode: result.recoveryCode,
          backedUp: result.backedUp,
        });
      });

      scope.post('/login/options', post, async () => service.startLogin());

      scope.post('/login/verify', post, async (request, reply) => {
        const ip = limited(`login:ip:${request.ip}`, limits.loginPerIp);
        if (!ip.allowed) return rejectLimited(reply, ip.retryAfterMs);
        const body = parse(authenticationResponse, request, reply);
        if (body === undefined) return reply;
        const result = await service.finishLogin(body, userGuard('login', limits.loginPerUser));
        if (!result.ok) {
          return fail(
            request,
            reply,
            'login',
            result,
            result.reason === 'unknown_challenge' ? 400 : 401,
          );
        }
        request.log.info({ event: 'login', outcome: 'ok', user_id: result.userId }, 'logged in');
        return setSession(reply, result.session).send({ userId: result.userId });
      });

      scope.post('/recovery/options', post, async (request, reply) => {
        const ip = limited(`recovery:ip:${request.ip}`, limits.recoveryPerIp);
        if (!ip.allowed) return rejectLimited(reply, ip.retryAfterMs);
        const body = parse(recoveryOptionsBody, request, reply);
        if (body === undefined) return reply;
        const result = await service.startRecovery(
          body.recoveryCode,
          userGuard('recovery', limits.recoveryPerUser),
        );
        if (!result.ok) return fail(request, reply, 'recovery', result, 403);
        return result.options;
      });

      scope.post('/recovery/verify', post, async (request, reply) => {
        const body = parse(registrationResponse, request, reply);
        if (body === undefined) return reply;
        const result = await service.finishRecovery(body);
        if (!result.ok) {
          return fail(
            request,
            reply,
            'recovery',
            result,
            result.reason === 'invalid_code' ? 403 : 400,
          );
        }
        request.log.info({ event: 'recovery', outcome: 'ok', user_id: result.userId }, 'recovered');
        return setSession(reply, result.session).send({
          userId: result.userId,
          recoveryCode: result.recoveryCode,
          backedUp: result.backedUp,
        });
      });

      async function authenticated(request: FastifyRequest, reply: Reply) {
        const session = await service.authenticate(sessionCookie.read(request.headers.cookie));
        if (!session.ok) {
          request.log.info(
            { event: 'session', outcome: 'rejected', reason: session.reason },
            'no session',
          );
          await reply
            .code(401)
            .header('set-cookie', sessionCookie.clear())
            .send({ error: 'unauthenticated' });
          return undefined;
        }
        const limit = limited(`session:user:${session.userId}`, limits.sessionPerUser);
        if (!limit.allowed) {
          await rejectLimited(reply, limit.retryAfterMs);
          return undefined;
        }
        return session;
      }

      scope.get('/session', async (request, reply) => {
        const session = await authenticated(request, reply);
        if (session === undefined) return reply;
        return reply
          .header(
            'set-cookie',
            sessionCookie.serialize(sessionCookie.read(request.headers.cookie)!, session.maxAgeSec),
          )
          .send({ userId: session.userId });
      });

      scope.post('/logout', post, async (request, reply) => {
        const session = await authenticated(request, reply);
        if (session === undefined) return reply;
        await service.revokeSession(session);
        request.log.info(
          { event: 'session_revoked', outcome: 'ok', user_id: session.userId },
          'logged out',
        );
        return reply.code(204).header('set-cookie', sessionCookie.clear()).send();
      });

      done();
    },
    { prefix: '/api/auth' },
  );
}
