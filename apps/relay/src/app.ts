import { sha256, utf8 } from '@remote-control/crypto';
import type { Clock } from '@remote-control/protocol';
import fastify, { LogController, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

import type { AccountService } from './core/account-service.js';
import type { DecisionVerifier } from './core/decision-verifier.js';
import type { PairingService } from './core/pairing-service.js';
import type { DrainState } from './core/drain-state.js';
import { FixedWindowRateLimiter } from './core/rate-limiter.js';
import {
  DEFAULT_AUTH_RATE_LIMITS,
  registerAuthRoutes,
  type AuthRateLimits,
} from './http/auth-routes.js';
import { DEFAULT_DECISION_RATE_LIMIT, registerDecisionRoutes } from './http/decision-routes.js';
import { registerAdminRoutes } from './http/admin-routes.js';
import { deviceAuth } from './http/device-auth.js';
import { registerHealthRoute } from './http/health-route.js';
import { registerOriginGuard } from './http/origin-guard-hook.js';
import {
  DEFAULT_PAIRING_RATE_LIMITS,
  registerPairingRoutes,
  type PairingRateLimits,
} from './http/pairing-routes.js';
import { registerPushRoutes } from './http/push-routes.js';
import { registerStateRoute } from './http/state-route.js';
import { registerStaticSite } from './http/static-site.js';
import { registerVersionRoute } from './http/version-route.js';
import type { RelayRouter } from './core/relay-router.js';
import type { AdminStatsStore } from './ports/audit-log.js';
import type { DatabaseHealth } from './ports/database-health.js';
import type { DeviceDirectory } from './ports/device-directory.js';
import type { HubPort } from './ports/hub.js';
import type { PushSubscriptionStore } from './ports/push-subscription-store.js';
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
  /** Web Push registration (M0-12); needs `auth` and `relay`. */
  readonly push?: PushDeps | undefined;
  /** Owner counters (M1-13); needs `relay` (online counts come from the hub). */
  readonly admin?: AdminDeps | undefined;
}

export interface AdminDeps {
  /** `RC_ADMIN_TOKEN`; only its SHA-256 is kept by the route. */
  readonly token: string;
  readonly stats: AdminStatsStore;
}

export interface PushDeps {
  readonly store: PushSubscriptionStore;
  /** VAPID public key handed to the PWA. */
  readonly publicKey: string;
  /** Which endpoints may be stored; default: the known browser push services. */
  readonly allowEndpoint?: (endpoint: string) => boolean;
}

export interface RelayDeps {
  readonly router: RelayRouter;
  readonly hub: HubPort;
  readonly directory: DeviceDirectory;
  /** Enrolment and pairing slots (M0-11); absent → `/api/pairings`, `/api/agents` do not exist. */
  readonly pairing?: PairingService | undefined;
  /** Decision verification (M0-11); also the router's command gate in production. */
  readonly decisions?: DecisionVerifier | undefined;
  readonly pairingLimits?: PairingRateLimits;
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
      registerDeviceApis(app, deps.relay, deps.auth.service, deps.clock);
      await registerWsRoute(app, {
        router: deps.relay.router,
        hub: deps.relay.hub,
        directory: deps.relay.directory,
        accounts: deps.auth.service,
        drain: deps.drain,
        clock: deps.clock,
        origin: deps.auth.origin,
      });
      if (deps.admin !== undefined) {
        registerAdminRoutes(app, {
          tokenHash: await sha256(utf8(deps.admin.token)),
          stats: deps.admin.stats,
          hub: deps.relay.hub,
          clock: deps.clock,
          limiter: new FixedWindowRateLimiter(deps.clock),
        });
      }
      if (deps.push !== undefined) {
        registerPushRoutes(app, {
          ...deps.push,
          accounts: deps.auth.service,
          directory: deps.relay.directory,
          clock: deps.clock,
          limiter: new FixedWindowRateLimiter(deps.clock),
        });
      }
    }
  }
  await registerStaticSite(app, deps.publicDir);

  return app;
}

/** `/api/devices`, `/api/agents`, `/api/pairings` and `/api/decisions` (M0-11). */
function registerDeviceApis(
  app: FastifyInstance,
  relay: RelayDeps,
  accounts: AccountService,
  clock: Clock,
): void {
  const auth = deviceAuth({
    accounts,
    directory: relay.directory,
    limiter: new FixedWindowRateLimiter(clock),
    now: () => clock.now(),
  });
  if (relay.pairing !== undefined) {
    registerPairingRoutes(app, {
      pairing: relay.pairing,
      auth,
      limits: relay.pairingLimits ?? DEFAULT_PAIRING_RATE_LIMITS,
    });
  }
  if (relay.decisions !== undefined) {
    registerDecisionRoutes(app, {
      verifier: relay.decisions,
      auth,
      limit: DEFAULT_DECISION_RATE_LIMIT,
    });
  }
}
