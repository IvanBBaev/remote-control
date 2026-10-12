import type { Clock } from '@remote-control/protocol';
import fastify, { LogController, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

import type { AccountService } from './core/account-service.js';
import type { DrainState } from './core/drain-state.js';
import { FixedWindowRateLimiter } from './core/rate-limiter.js';
import {
  DEFAULT_AUTH_RATE_LIMITS,
  registerAuthRoutes,
  type AuthRateLimits,
} from './http/auth-routes.js';
import { registerHealthRoute } from './http/health-route.js';
import { registerOriginGuard } from './http/origin-guard-hook.js';
import { registerStateRoute } from './http/state-route.js';
import { registerStaticSite } from './http/static-site.js';
import { registerVersionRoute } from './http/version-route.js';
import type { RelayRouter } from './core/relay-router.js';
import type { DatabaseHealth } from './ports/database-health.js';
import type { DeviceDirectory } from './ports/device-directory.js';
import type { HubPort } from './ports/hub.js';
import { registerWsRoute } from './ws/ws-route.js';

export interface AppDeps {
  readonly logger: Logger;
  readonly clock: Clock;
  readonly database: DatabaseHealth;
  readonly drain: DrainState;
  /** Relay package version. */
  readonly version: string;
  /** Git commit of the build, `null` outside Railway. */
  readonly commit: string | null;
  /** PWA build directory; missing or `undefined` disables static serving. */
  readonly publicDir: string | undefined;
  /** PEM certificate and key for local HTTPS (`pnpm dev:https`). */
  readonly tls?: { readonly cert: Buffer; readonly key: Buffer } | undefined;
  /** Reverse proxies in front of the relay whose `X-Forwarded-For` is trusted (`request.ip`). */
  readonly trustProxyHops?: number;
  /** Accounts (D8); absent without a database, and then `/api/auth/*` does not exist. */
  readonly auth?: AuthDeps | undefined;
  /** The WebSocket hub (D15); needs `auth` (phones log in with the session cookie). */
  readonly relay?: RelayDeps | undefined;
}

export interface RelayDeps {
  readonly router: RelayRouter;
  readonly hub: HubPort;
  readonly directory: DeviceDirectory;
}

export interface AuthDeps {
  readonly service: AccountService;
  /** The PWA origin (`RC_ORIGIN`) every state-changing request must come from. */
  readonly origin: string;
  readonly limits?: AuthRateLimits;
}

/**
 * Builds the relay's Fastify app without listening (tests use `inject`). Every
 * dependency comes in through `deps`; `container.ts` wires the real adapters.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const hops = deps.trustProxyHops ?? 0;
  const common = {
    loggerInstance: deps.logger,
    // Railway's edge sets this per request; it becomes `req_id` in every log line (D19).
    requestIdHeader: 'x-railway-request-id',
    logController: new LogController({ requestIdLogLabel: 'req_id' }),
    // Trust the nearest `hops` proxies (Railway's edge) for `request.ip`, nothing beyond.
    trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false,
  };
  // The HTTPS variant has a different server type parameter; routes do not care.
  const app = (deps.tls
    ? fastify({ ...common, https: deps.tls })
    : fastify(common)) as unknown as FastifyInstance;

  // D15: once closing starts, `/health` answers 503, new upgrades get 503 and every
  // socket is closed with 1012 (clients reconnect with jitter to the next replica).
  app.addHook('preClose', async () => {
    deps.drain.begin();
    if (deps.relay !== undefined) {
      const closed = await deps.relay.router.drain();
      deps.logger.info({ event: 'ws_drain', sockets: closed }, 'websockets closed');
    }
  });

  const shared = { version: deps.version, commit: deps.commit };
  registerHealthRoute(app, {
    ...shared,
    clock: deps.clock,
    database: deps.database,
    drain: deps.drain,
    startedAt: deps.clock.now(),
  });
  registerVersionRoute(app, shared);
  if (deps.auth !== undefined) {
    registerOriginGuard(app, deps.auth.origin);
    registerAuthRoutes(app, {
      service: deps.auth.service,
      limiter: new FixedWindowRateLimiter(deps.clock),
      limits: deps.auth.limits ?? DEFAULT_AUTH_RATE_LIMITS,
    });
    if (deps.relay !== undefined) {
      registerStateRoute(app, {
        accounts: deps.auth.service,
        directory: deps.relay.directory,
        hub: deps.relay.hub,
        clock: deps.clock,
      });
      await registerWsRoute(app, {
        ...deps.relay,
        accounts: deps.auth.service,
        drain: deps.drain,
        clock: deps.clock,
        origin: deps.auth.origin,
      });
    }
  }
  await registerStaticSite(app, deps.publicDir);

  return app;
}
