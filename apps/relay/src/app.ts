import type { Clock } from '@remote-control/protocol';
import fastify, { LogController, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

import type { DrainState } from './core/drain-state.js';
import { registerHealthRoute } from './http/health-route.js';
import { registerStaticSite } from './http/static-site.js';
import { registerVersionRoute } from './http/version-route.js';
import type { DatabaseHealth } from './ports/database-health.js';

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
}

/**
 * Builds the relay's Fastify app without listening (tests use `inject`). Every
 * dependency comes in through `deps`; `container.ts` wires the real adapters.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const common = {
    loggerInstance: deps.logger,
    // Railway's edge sets this per request; it becomes `req_id` in every log line (D19).
    requestIdHeader: 'x-railway-request-id',
    logController: new LogController({ requestIdLogLabel: 'req_id' }),
  };
  // The HTTPS variant has a different server type parameter; routes do not care.
  const app = (deps.tls
    ? fastify({ ...common, https: deps.tls })
    : fastify(common)) as unknown as FastifyInstance;

  // D15: once closing starts, `/health` answers 503. Later work packages add the WS
  // drain (close every socket with 1012) to this hook.
  app.addHook('preClose', (done) => {
    deps.drain.begin();
    done();
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
  await registerStaticSite(app, deps.publicDir);

  return app;
}
