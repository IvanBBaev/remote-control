import type { Clock } from '@remote-control/protocol';
import type { FastifyInstance } from 'fastify';

import type { DrainState } from '../core/drain-state.js';
import { healthReport } from '../core/health-report.js';
import type { DatabaseHealth } from '../ports/database-health.js';

export interface HealthRouteDeps {
  readonly clock: Clock;
  readonly database: DatabaseHealth;
  readonly drain: DrainState;
  readonly version: string;
  readonly commit: string | null;
  /** Epoch ms at which the app was built, for `uptimeSec`. */
  readonly startedAt: number;
}

/**
 * `GET /health` for Railway's deploy check and the uptime monitor. Logged at `warn`
 * so the pings do not fill the logs (03 §5.12).
 */
export function registerHealthRoute(app: FastifyInstance, deps: HealthRouteDeps): void {
  app.get('/health', { logLevel: 'warn' }, async (_request, reply) => {
    const draining = deps.drain.isDraining();
    const report = healthReport({
      draining,
      db: draining ? undefined : await deps.database.check(),
      version: deps.version,
      commit: deps.commit,
      uptimeSec: Math.floor((deps.clock.now() - deps.startedAt) / 1000),
    });
    return reply.code(report.statusCode).header('cache-control', 'no-store').send(report.body);
  });
}
